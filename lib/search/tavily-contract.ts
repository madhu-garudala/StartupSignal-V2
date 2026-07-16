import { z } from "zod";

export const TavilySearchResultSchema = z.object({
  title: z.string().catch("Untitled source"),
  url: z.string(),
  content: z.string().nullable().optional(),
  score: z.number().nullable().optional(),
  raw_content: z.string().nullable().optional(),
});

export const TavilySearchResponseSchema = z.object({
  results: z.array(TavilySearchResultSchema).default([]),
  response_time: z.union([z.string(), z.number()]).optional(),
  request_id: z.string().optional(),
  usage: z.object({ credits: z.number().optional() }).optional(),
});

export const TavilyExtractResponseSchema = z.object({
  results: z.array(z.object({ url: z.string(), raw_content: z.string() })).default([]),
  failed_results: z.array(z.unknown()).default([]),
  response_time: z.number().optional(),
  request_id: z.string().optional(),
  usage: z.object({ credits: z.number().optional() }).optional(),
});

export type TavilySearchResult = z.infer<typeof TavilySearchResultSchema>;

const excludedOfficialWebsiteHosts = [
  "angel.co",
  "cbinsights.com",
  "crunchbase.com",
  "facebook.com",
  "github.com",
  "instagram.com",
  "linkedin.com",
  "pitchbook.com",
  "reddit.com",
  "reuters.com",
  "tiktok.com",
  "tracxn.com",
  "wikipedia.org",
  "x.com",
  "youtube.com",
];

function compactIdentity(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizedIdentity(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function baseHostname(hostname: string) {
  return hostname.toLowerCase().replace(/^www\./, "");
}

export function looksLikeWebsiteInput(value: string) {
  const input = value.trim();
  if (/^https?:\/\//i.test(input)) return true;
  if (/\s/.test(input)) return false;
  const hostname = input.split(/[/?#]/, 1)[0].replace(/:\d+$/, "");
  return hostname.includes(".") || hostname === "localhost";
}

export function isExcludedOfficialWebsite(hostname: string) {
  const host = baseHostname(hostname);
  return excludedOfficialWebsiteHosts.some((excluded) => host === excluded || host.endsWith(`.${excluded}`));
}

export function rankOfficialWebsiteCandidates(companyName: string, results: TavilySearchResult[]) {
  const compactName = compactIdentity(companyName);
  const normalizedName = normalizedIdentity(companyName);
  if (!compactName) return [];

  return results.flatMap((result) => {
    let url: URL;
    try {
      url = new URL(result.url);
    } catch {
      return [];
    }
    const hostname = baseHostname(url.hostname);
    if (!["http:", "https:"].includes(url.protocol) || isExcludedOfficialWebsite(hostname)) return [];

    const domainLabel = hostname.split(".")[0].replace(/[^a-z0-9]/g, "");
    const normalizedTitle = normalizedIdentity(result.title);
    const normalizedContent = normalizedIdentity(result.content || "");
    const exactDomain = domainLabel === compactName;
    const titleMatch = normalizedTitle === normalizedName || normalizedTitle.startsWith(`${normalizedName} `);
    let confidence = Math.max(0, Math.min(1, result.score ?? 0)) * 2;
    if (exactDomain) confidence += 8;
    else if (domainLabel.length >= 4 && (compactName.includes(domainLabel) || domainLabel.includes(compactName))) confidence += 3;
    if (titleMatch) confidence += 4;
    else if (normalizedTitle.includes(normalizedName)) confidence += 2;
    if (normalizedContent.includes(normalizedName)) confidence += 1.5;
    if (url.pathname === "/" || url.pathname === "") confidence += 1.5;
    else confidence -= 1;

    return [{ result, confidence, exactDomain, hostname }];
  }).sort((left, right) => right.confidence - left.confidence);
}

export function isSupportedEvidenceUrl(value: string) {
  try {
    const pathname = new URL(value).pathname.toLowerCase();
    return !/\.(?:csv|docx?|ods|pptx?|rtf|xlsm?|xlsx|xml|zip)$/i.test(pathname);
  } catch {
    return false;
  }
}

export function isUsefulEvidenceText(value: string) {
  const cleaned = cleanTavilyContent(value);
  if (cleaned.length < 80) return false;
  const words = cleaned.match(/\p{L}[\p{L}\p{M}'’-]{2,}/gu) || [];
  const wordCharacters = words.reduce((total, word) => total + word.length, 0);
  return words.length >= 10 && wordCharacters / cleaned.length >= 0.42;
}

export function evidenceMentionsCompany(companyTerm: string, title: string, excerpt: string, url: string) {
  const identity = compactIdentity(companyTerm);
  if (!identity) return false;
  let hostname = "";
  try { hostname = new URL(url).hostname; } catch { /* Invalid URLs fail through the empty hostname. */ }
  return compactIdentity(`${title} ${excerpt} ${hostname}`).includes(identity);
}

export function isSameSite(candidate: URL, submitted: URL) {
  const base = baseHostname(submitted.hostname);
  const hostname = baseHostname(candidate.hostname);
  return hostname === base || hostname.endsWith(`.${base}`);
}

export function sourceKey(value: string) {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith("utm_") || key === "ref") url.searchParams.delete(key);
    }
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return value.trim().toLowerCase();
  }
}

export function cleanTavilyContent(value: string) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
