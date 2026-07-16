import "server-only";

import type { ZodType } from "zod";
import type { SourceDocument } from "@/lib/schemas/investigation";
import { assertPublicDestination, normalizePublicUrl } from "@/lib/security/url";
import {
  baseHostname,
  cleanTavilyContent,
  isSameSite,
  sourceKey,
  TavilyExtractResponseSchema,
  TavilySearchResponseSchema,
  type TavilySearchResult,
} from "@/lib/search/tavily-contract";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const TAVILY_EXTRACT_URL = "https://api.tavily.com/extract";
const REQUEST_TIMEOUT_MS = 14_000;
const MAX_SEARCH_SOURCES = 6;
const MAX_EXCERPT_CHARACTERS = 4_000;
type SearchCandidate = TavilySearchResult & { scope: "first-party" | "independent" };

async function tavilyRequest<T>(endpoint: string, body: Record<string, unknown>, schema: ZodType<T>, externalSignal?: AbortSignal): Promise<T> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY is not configured.");
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = externalSignal ? AbortSignal.any([externalSignal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
      cache: "no-store",
  });
  if (!response.ok) throw new Error(`Tavily returned HTTP ${response.status}.`);
  return schema.parse(await response.json());
}

async function publicCandidate(result: TavilySearchResult, submitted: URL, scope: "first-party" | "independent") {
  try {
    const url = normalizePublicUrl(result.url);
    const sameSite = isSameSite(url, submitted);
    if ((scope === "first-party" && !sameSite) || (scope === "independent" && sameSite)) return null;
    await assertPublicDestination(url);
    return { ...result, url: url.toString(), scope };
  } catch {
    return null;
  }
}

async function extractCandidates(candidates: SearchCandidate[], query: string, idPrefix: string, signal?: AbortSignal) {
  const warnings: string[] = [];
  const extracted = new Map<string, string>();
  try {
    const response = await tavilyRequest(TAVILY_EXTRACT_URL, {
      urls: candidates.map((candidate) => candidate.url),
      query,
      chunks_per_source: 2,
      extract_depth: "basic",
      format: "markdown",
      timeout: 12,
      include_images: false,
      include_usage: true,
    }, TavilyExtractResponseSchema, signal);
    for (const result of response.results) extracted.set(sourceKey(result.url), result.raw_content);
    if (response.failed_results.length) warnings.push(`TAVILY EXTRACT: ${response.failed_results.length} selected source(s) could not be extracted; search excerpts were used where available.`);
  } catch {
    warnings.push("TAVILY EXTRACT: Clean extraction was unavailable; bounded search excerpts were used instead.");
  }

  const fetchedAt = new Date().toISOString();
  const sources: SourceDocument[] = candidates.flatMap((candidate, index) => {
    const rawContent = extracted.get(sourceKey(candidate.url));
    const excerpt = cleanTavilyContent(rawContent || candidate.content || "").slice(0, MAX_EXCERPT_CHARACTERS);
    if (!excerpt) return [];
    const extractedSource = Boolean(rawContent);
    return [{
      id: `source-${idPrefix}-${index + 1}`,
      title: candidate.title.trim().slice(0, 180) || new URL(candidate.url).hostname,
      url: candidate.url,
      sourceType: candidate.scope === "first-party"
        ? `First-party ${extractedSource ? "Tavily extraction" : "Tavily search excerpt"}`
        : `Independent ${extractedSource ? "Tavily extraction" : "Tavily search excerpt"}`,
      excerpt,
      fetchedAt,
      reliability: extractedSource ? "medium" as const : "low" as const,
      isDemo: false,
    }];
  });
  return { sources, warnings };
}

export async function searchCompanyEvidence(canonicalUrl: string, signal?: AbortSignal) {
  if (!process.env.TAVILY_API_KEY) {
    return { sources: [] as SourceDocument[], warnings: ["TAVILY UNAVAILABLE: Search enrichment was skipped because TAVILY_API_KEY is not configured."] };
  }

  const submitted = new URL(canonicalUrl);
  const domain = baseHostname(submitted.hostname);
  const companyTerm = domain.split(".")[0].replace(/[-_]+/g, " ");
  const common = {
    search_depth: "basic",
    topic: "general",
    max_results: 6,
    include_answer: false,
    include_raw_content: false,
    include_images: false,
    include_usage: true,
    safe_search: true,
  };
  const searchCalls = await Promise.allSettled([
    tavilyRequest(TAVILY_SEARCH_URL, {
      ...common,
      query: `site:${domain} product company team pricing customers documentation`,
      include_domains: [domain],
    }, TavilySearchResponseSchema, signal),
    tavilyRequest(TAVILY_SEARCH_URL, {
      ...common,
      query: `"${companyTerm}" funding revenue valuation customers competitors risk`,
      exclude_domains: [domain, "reddit.com", "linkedin.com", "youtube.com", "facebook.com", "instagram.com", "tiktok.com", "twitter.com", "x.com"],
      exact_match: true,
    }, TavilySearchResponseSchema, signal),
  ]);

  const warnings: string[] = [];
  const candidates: SearchCandidate[] = [];
  for (const [index, call] of searchCalls.entries()) {
    const scope = index === 0 ? "first-party" as const : "independent" as const;
    if (call.status === "rejected") {
      warnings.push(`TAVILY PARTIAL FAILURE: ${scope} search was unavailable.`);
      continue;
    }
    const checked = await Promise.all(call.value.results.map((result) => publicCandidate(result, submitted, scope)));
    candidates.push(...checked
      .filter((result): result is NonNullable<typeof result> => Boolean(result))
      .filter((result) => scope === "first-party" || (result.score ?? 0) >= 0.25)
      .slice(0, 3));
  }

  const unique = candidates
    .filter((candidate, index, list) => list.findIndex((item) => sourceKey(item.url) === sourceKey(candidate.url)) === index)
    .slice(0, MAX_SEARCH_SOURCES);
  if (!unique.length) {
    return { sources: [] as SourceDocument[], warnings: [...warnings, "TAVILY SEARCH: No validated public sources were returned."] };
  }

  const extracted = await extractCandidates(unique, `${domain} company product founders customers business model traction risks`, "tavily", signal);

  return {
    sources: extracted.sources,
    warnings: [
      ...warnings,
      ...extracted.warnings,
      `TAVILY SEARCH: ${extracted.sources.length} bounded indexed source(s) were added. Search and extracted content remain untrusted evidence.`,
    ],
  };
}

export async function searchQuestionEvidence(canonicalUrl: string, question: string, signal?: AbortSignal) {
  if (!process.env.TAVILY_API_KEY) {
    return { sources: [] as SourceDocument[], warnings: ["TAVILY UNAVAILABLE: The answer used only evidence from the current investigation."] };
  }

  const submitted = new URL(canonicalUrl);
  const domain = baseHostname(submitted.hostname);
  const companyTerm = domain.split(".")[0].replace(/[-_]+/g, " ");
  const boundedQuestion = question.replace(/\s+/g, " ").trim().slice(0, 500);
  const common = {
    search_depth: "basic",
    topic: "general",
    max_results: 5,
    include_answer: false,
    include_raw_content: false,
    include_images: false,
    include_usage: true,
    safe_search: true,
  };
  const calls = await Promise.allSettled([
    tavilyRequest(TAVILY_SEARCH_URL, {
      ...common,
      query: `site:${domain} ${boundedQuestion}`,
      include_domains: [domain],
    }, TavilySearchResponseSchema, signal),
    tavilyRequest(TAVILY_SEARCH_URL, {
      ...common,
      query: `"${companyTerm}" ${boundedQuestion}`,
      exclude_domains: [domain, "reddit.com", "linkedin.com", "youtube.com", "facebook.com", "instagram.com", "tiktok.com", "twitter.com", "x.com"],
    }, TavilySearchResponseSchema, signal),
  ]);

  const warnings: string[] = [];
  const candidates: SearchCandidate[] = [];
  for (const [index, call] of calls.entries()) {
    const scope = index === 0 ? "first-party" as const : "independent" as const;
    if (call.status === "rejected") {
      warnings.push(`TAVILY CHAT PARTIAL FAILURE: ${scope} search was unavailable.`);
      continue;
    }
    const checked = await Promise.all(call.value.results.map((result) => publicCandidate(result, submitted, scope)));
    candidates.push(...checked
      .filter((result): result is NonNullable<typeof result> => Boolean(result))
      .filter((result) => scope === "first-party" || (result.score ?? 0) >= 0.2)
      .slice(0, 2));
  }

  const unique = candidates
    .filter((candidate, index, list) => list.findIndex((item) => sourceKey(item.url) === sourceKey(candidate.url)) === index)
    .slice(0, 4);
  if (!unique.length) return { sources: [] as SourceDocument[], warnings: [...warnings, "TAVILY CHAT SEARCH: No additional validated sources were returned."] };

  const extracted = await extractCandidates(unique, `${companyTerm}: ${boundedQuestion}`, "chat", signal);
  return {
    sources: extracted.sources,
    warnings: [...warnings, ...extracted.warnings, `TAVILY CHAT SEARCH: ${extracted.sources.length} question-specific source(s) were added.`],
  };
}
