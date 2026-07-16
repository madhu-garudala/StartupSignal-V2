import * as cheerio from "cheerio";
import type { LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { normalizePublicUrl, resolvePublicDestination, UrlSecurityError } from "@/lib/security/url";
import type { SourceDocument } from "@/lib/schemas/investigation";

const MAX_REDIRECTS = 3;
export const MAX_PAGE_BYTES = 500_000;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_PAGES = 4;

type FetchedPage = { url: URL; html: string; contentType: string; truncated: boolean };
type BodyResponse = { body: unknown };
type SitemapEntry = { url: URL; lastModified: string | null };
type ParsedSitemap = { sitemaps: URL[]; pages: SitemapEntry[] };

export class CrawlHttpError extends Error {
  constructor(public readonly status: number, public readonly url: string) {
    super(`Website returned HTTP ${status}.`);
    this.name = "CrawlHttpError";
  }
}

export async function readBoundedBody(response: BodyResponse, maxBytes = MAX_PAGE_BYTES, encoding = "utf-8") {
  const reader = (response.body as ReadableStream<Uint8Array> | null)?.getReader();
  if (!reader) return { text: "", truncated: false, bytesRead: 0 };
  let decoder: TextDecoder;
  try { decoder = new TextDecoder(encoding); } catch { decoder = new TextDecoder(); }
  let bytes = 0;
  let output = "";
  let truncated = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const remaining = maxBytes - bytes;
    if (remaining <= 0) {
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    if (value.byteLength > remaining) {
      output += decoder.decode(value.subarray(0, remaining), { stream: true });
      bytes += remaining;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    bytes += value.byteLength;
    output += decoder.decode(value, { stream: true });
  }
  return { text: output + decoder.decode(), truncated, bytesRead: bytes };
}

export async function secureFetch(startUrl: URL, accept = "text/html, text/plain;q=0.9", externalSignal?: AbortSignal): Promise<FetchedPage> {
  let url = startUrl;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const addresses = await resolvePublicDestination(url);
    const selected = addresses.find((address) => address.family === 4) || addresses[0];
    const lookup: LookupFunction = (_hostname, _options, callback) => callback(null, selected.address, selected.family);
    const dispatcher = new Agent({
      connections: 1,
      pipelining: 0,
      connect: { lookup, timeout: REQUEST_TIMEOUT_MS },
    });
    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = externalSignal ? AbortSignal.any([externalSignal, timeoutSignal]) : timeoutSignal;
    try {
      const response = await undiciFetch(url, {
        dispatcher,
        redirect: "manual",
        signal,
        headers: { Accept: accept, "User-Agent": "StartupSignalBot/1.0 (+bounded research crawler)" },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (!location || redirect === MAX_REDIRECTS) throw new UrlSecurityError("The website redirected too many times.");
        url = normalizePublicUrl(new URL(location, url).toString());
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new CrawlHttpError(response.status, url.toString());
      }
      const contentTypeHeader = response.headers.get("content-type") || "";
      const contentType = contentTypeHeader.split(";")[0].trim().toLowerCase();
      if (!["text/html", "text/plain", "application/xml", "text/xml", "application/rss+xml"].includes(contentType)) {
        await response.body?.cancel().catch(() => undefined);
        throw new UrlSecurityError("The URL did not return a supported text page.");
      }
      const charset = contentTypeHeader.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1] || "utf-8";
      const body = await readBoundedBody(response, MAX_PAGE_BYTES, charset);
      return { url, html: body.text, contentType, truncated: body.truncated };
    } finally {
      await dispatcher.close();
    }
  }
  throw new UrlSecurityError("Unable to fetch the website safely.");
}

type RobotsRule = { allow: boolean; pattern: string };

function robotsPattern(pattern: string) {
  const anchored = pattern.endsWith("$");
  const value = anchored ? pattern.slice(0, -1) : pattern;
  const source = value.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${source}${anchored ? "$" : ""}`);
}

export function parseRobots(text: string) {
  const groups: Array<{ agents: string[]; rules: RobotsRule[] }> = [];
  let group = { agents: [] as string[], rules: [] as RobotsRule[] };
  const flush = () => {
    if (group.agents.length) groups.push(group);
    group = { agents: [], rules: [] };
  };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) continue;
    const [key, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    const normalizedKey = key?.toLowerCase();
    if (normalizedKey === "user-agent") {
      if (group.rules.length) flush();
      group.agents.push(value.toLowerCase());
    } else if ((normalizedKey === "allow" || normalizedKey === "disallow") && group.agents.length && value) {
      group.rules.push({ allow: normalizedKey === "allow", pattern: value });
    }
  }
  flush();

  const specific = groups.filter((entry) => entry.agents.includes("startupsignalbot"));
  const selected = specific.length ? specific : groups.filter((entry) => entry.agents.includes("*"));
  const rules = selected.flatMap((entry) => entry.rules);
  return (url: URL) => {
    const path = `${url.pathname}${url.search}`;
    const matches = rules
      .filter((rule) => robotsPattern(rule.pattern).test(path))
      .sort((left, right) => right.pattern.replace(/\$$/, "").length - left.pattern.replace(/\$$/, "").length || Number(right.allow) - Number(left.allow));
    return matches[0]?.allow ?? true;
  };
}

async function robotsPolicy(origin: string, signal?: AbortSignal) {
  try {
    const page = await secureFetch(new URL("/robots.txt", origin), "text/plain", signal);
    return parseRobots(page.html);
  } catch {
    return () => true;
  }
}

function extractPage(page: FetchedPage, id: number): SourceDocument & { links: URL[]; truncated: boolean } {
  const $ = cheerio.load(page.html);
  $("script, style, noscript, iframe, svg, form").remove();
  const title = $("title").first().text().trim() || $("h1").first().text().trim() || page.url.hostname;
  const description = $("meta[name='description']").attr("content")?.trim();
  const text = $("main, article, body").first().text().replace(/\s+/g, " ").trim().slice(0, 12_000);
  const excerpt = [description, text].filter(Boolean).join(" ").slice(0, 4_000) || "No readable page copy was discovered.";
  const links = $("a[href]")
    .map((_, element) => {
      try { return new URL($(element).attr("href")!, page.url); } catch { return null; }
    })
    .get()
    .filter((url): url is URL => Boolean(url))
    .filter((url) => url.origin === page.url.origin && ["http:", "https:"].includes(url.protocol));

  return {
    id: `source-${id}`,
    title: title.slice(0, 180),
    url: page.url.toString(),
    sourceType: id === 1 ? "Company homepage" : "Company website",
    excerpt,
    fetchedAt: new Date().toISOString(),
    reliability: "high",
    isDemo: false,
    links,
    truncated: page.truncated,
  };
}

const usefulPath = /(product|platform|solution|pricing|about|team|founder|customer|case|docs|developer|career|job|blog)/i;

export function parseSitemap(xml: string, baseUrl: URL): ParsedSitemap {
  const $ = cheerio.load(xml, { xmlMode: true });
  const urls = (selector: string) => $(selector).map((_, element) => {
    try {
      const url = new URL($(element).text().trim(), baseUrl);
      return url.origin === baseUrl.origin ? url : null;
    } catch {
      return null;
    }
  }).get().filter((url): url is URL => Boolean(url));

  const pages = $("url").map((_, element) => {
    try {
      const url = new URL($(element).children("loc").first().text().trim(), baseUrl);
      if (url.origin !== baseUrl.origin) return null;
      return { url, lastModified: $(element).children("lastmod").first().text().trim() || null };
    } catch {
      return null;
    }
  }).get().filter((entry): entry is SitemapEntry => Boolean(entry));

  return { sitemaps: urls("sitemap > loc"), pages };
}

function sitemapPriority(url: URL) {
  const path = url.pathname.toLowerCase();
  const priorities = ["company", "about", "product", "platform", "startup", "pricing", "customer", "api", "research", "safety", "page"];
  const index = priorities.findIndex((keyword) => path.includes(keyword));
  return index === -1 ? priorities.length : index;
}

function sitemapTitle(url: URL) {
  const parts = url.pathname.split("/").filter(Boolean);
  const label = parts.at(-1)?.replace(/[-_]+/g, " ") || "site";
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} sitemap`;
}

async function crawlSitemapEvidence(start: URL, blockedStatus: number, allowed: (url: URL) => boolean, signal?: AbortSignal) {
  const rootUrl = new URL("/sitemap.xml", start.origin);
  const rootPage = await secureFetch(rootUrl, "application/xml, text/xml;q=0.9, text/plain;q=0.8", signal);
  const root = parseSitemap(rootPage.html, rootPage.url);
  const catalogs: Array<{ sitemapUrl: URL; entries: SitemapEntry[]; truncated: boolean }> = [];
  if (root.pages.length) catalogs.push({ sitemapUrl: rootPage.url, entries: root.pages, truncated: rootPage.truncated });

  const nested = root.sitemaps
    .filter(allowed)
    .sort((left, right) => sitemapPriority(left) - sitemapPriority(right))
    .slice(0, MAX_PAGES);
  for (const sitemapUrl of nested) {
    try {
      const page = await secureFetch(sitemapUrl, "application/xml, text/xml;q=0.9, text/plain;q=0.8", signal);
      const parsed = parseSitemap(page.html, page.url);
      if (parsed.pages.length) catalogs.push({ sitemapUrl: page.url, entries: parsed.pages, truncated: page.truncated });
    } catch {
      // A blocked sitemap category should not invalidate other first-party catalogs.
    }
  }

  const sources: SourceDocument[] = catalogs.slice(0, MAX_PAGES).flatMap((catalog, index) => {
    const entries = catalog.entries
      .filter((entry) => allowed(entry.url))
      .sort((left, right) => Number(usefulPath.test(right.url.pathname)) - Number(usefulPath.test(left.url.pathname)))
      .filter((entry, entryIndex, list) => list.findIndex((item) => item.url.pathname === entry.url.pathname) === entryIndex)
      .slice(0, 18);
    const paths = entries.map((entry) => `${entry.url.pathname}${entry.lastModified ? ` (updated ${entry.lastModified})` : ""}`);
    if (!paths.length) return [];
    return [{
      id: `source-sitemap-${index + 1}`,
      title: sitemapTitle(catalog.sitemapUrl),
      url: catalog.sitemapUrl.toString(),
      sourceType: "First-party sitemap catalog",
      excerpt: `SITEMAP-ONLY EVIDENCE: Direct page content returned HTTP ${blockedStatus}. This published first-party sitemap catalogs these paths and optional timestamps only: ${paths.join("; ")}. URL names do not prove claims about page content.`,
      fetchedAt: new Date().toISOString(),
      reliability: "medium" as const,
      isDemo: false,
    }];
  });

  if (!sources.length) throw new CrawlHttpError(blockedStatus, start.toString());
  const warnings = [
    `DIRECT CRAWL BLOCKED: The submitted page returned HTTP ${blockedStatus}. Analysis used only first-party sitemap catalogs that remained publicly accessible.`,
    "SITEMAP-ONLY EVIDENCE: URL paths and timestamps confirm published catalog entries, not the contents or claims of the linked pages.",
  ];
  for (const catalog of catalogs.slice(0, MAX_PAGES)) {
    if (catalog.truncated) warnings.push(`SOURCE TRUNCATED: ${catalog.sitemapUrl} exceeded the ${MAX_PAGE_BYTES / 1_000} KB fetch limit. Analysis used only the bounded prefix.`);
  }
  return { canonicalUrl: start.toString(), sources, warnings, evidenceMode: "sitemap" as const };
}

export async function crawlCompany(input: string, signal?: AbortSignal) {
  const start = normalizePublicUrl(input);
  const allowed = await robotsPolicy(start.origin, signal);
  if (!allowed(start)) throw new UrlSecurityError("The site robots policy disallows crawling the submitted page.");

  let fetchedFirst: FetchedPage;
  try {
    fetchedFirst = await secureFetch(start, undefined, signal);
  } catch (error) {
    if (error instanceof CrawlHttpError && [403, 429].includes(error.status)) {
      return crawlSitemapEvidence(start, error.status, allowed, signal);
    }
    throw error;
  }
  const first = extractPage(fetchedFirst, 1);
  const warnings: string[] = [];
  if (first.truncated) warnings.push(`SOURCE TRUNCATED: ${first.url} exceeded the ${MAX_PAGE_BYTES / 1_000} KB fetch limit. Analysis used only the bounded prefix.`);
  const queue = first.links
    .filter(allowed)
    .filter((url) => usefulPath.test(url.pathname))
    .filter((url, index, list) => list.findIndex((item) => item.pathname === url.pathname) === index)
    .slice(0, MAX_PAGES - 1);
  const { links: firstLinks, truncated: firstTruncated, ...firstSource } = first;
  void firstLinks;
  void firstTruncated;
  const sources: SourceDocument[] = [firstSource];

  for (const url of queue) {
    try {
      const page = extractPage(await secureFetch(url, undefined, signal), sources.length + 1);
      if (page.truncated) warnings.push(`SOURCE TRUNCATED: ${page.url} exceeded the ${MAX_PAGE_BYTES / 1_000} KB fetch limit. Analysis used only the bounded prefix.`);
      const { links: _links, truncated: _truncated, ...source } = page;
      void _links;
      void _truncated;
      sources.push(source);
    } catch {
      // One inaccessible secondary page should not invalidate a usable homepage corpus.
    }
  }
  return { canonicalUrl: first.url, sources, warnings, evidenceMode: "pages" as const };
}
