import "server-only";

import type { ZodType } from "zod";
import { withTransientProviderRetry } from "@/lib/ai/provider-retry";
import type { SourceDocument } from "@/lib/schemas/investigation";
import { assertPublicDestination, normalizePublicUrl } from "@/lib/security/url";
import {
  baseHostname,
  cleanTavilyContent,
  evidenceMentionsCompany,
  isSameSite,
  isSupportedEvidenceUrl,
  isUsefulEvidenceText,
  looksLikeWebsiteInput,
  rankOfficialWebsiteCandidates,
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

async function tavilyRequest<T>(
  endpoint: string,
  body: Record<string, unknown>,
  schema: ZodType<T>,
  externalSignal?: AbortSignal,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY is not configured.");
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = externalSignal ? AbortSignal.any([externalSignal, timeoutSignal]) : timeoutSignal;
  const response = await withTransientProviderRetry(async () => {
    const result = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
      cache: "no-store",
    });
    if (result.status === 429 || result.status >= 500) {
      const error = Object.assign(new Error(`Tavily returned HTTP ${result.status}.`), {
        status: result.status,
        headers: { "retry-after": result.headers.get("retry-after") },
      });
      await result.body?.cancel().catch(() => undefined);
      throw error;
    }
    return result;
  }, { signal });
  if (!response.ok) throw new Error(`Tavily returned HTTP ${response.status}.`);
  return schema.parse(await response.json());
}

export async function resolveStartupWebsite(input: string, signal?: AbortSignal) {
  if (looksLikeWebsiteInput(input)) {
    return { url: normalizePublicUrl(input), warnings: [] as string[] };
  }
  if (!process.env.TAVILY_API_KEY) {
    throw new Error("Startup name lookup requires TAVILY_API_KEY. Enter the company website URL instead.");
  }

  const companyName = input.replace(/\s+/g, " ").trim().slice(0, 160);
  let response: Awaited<ReturnType<typeof tavilyRequest<typeof TavilySearchResponseSchema._output>>>;
  try {
    response = await tavilyRequest(TAVILY_SEARCH_URL, {
      query: `"${companyName}" official website startup company`,
      search_depth: "basic",
      topic: "general",
      max_results: 8,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      include_usage: true,
      safe_search: true,
      exact_match: true,
      exclude_domains: [
      "angel.co", "cbinsights.com", "crunchbase.com", "facebook.com",
        "github.com", "instagram.com", "linkedin.com", "pitchbook.com", "reddit.com",
        "reuters.com", "tiktok.com", "tracxn.com", "wikipedia.org", "x.com", "youtube.com",
      ],
    }, TavilySearchResponseSchema, signal, 8_000);
  } catch (error) {
    if ((error as { status?: number } | null)?.status === 429) {
      throw new Error("Startup name lookup is temporarily busy. Enter the company website URL or try again shortly.");
    }
    throw error;
  }

  const validated = (await Promise.all(response.results.map(async (result) => {
    try {
      const candidate = normalizePublicUrl(result.url);
      const origin = new URL(candidate.origin);
      await assertPublicDestination(origin);
      return { ...result, url: origin.toString() };
    } catch {
      return null;
    }
  }))).filter((result): result is TavilySearchResult => Boolean(result));
  const ranked = rankOfficialWebsiteCandidates(companyName, validated);
  const best = ranked[0];
  const runnerUp = ranked.find((candidate) => candidate.hostname !== best?.hostname);
  const clearMatch = best && best.confidence >= 7.5
    && (best.exactDomain || !runnerUp || best.confidence - runnerUp.confidence >= 1);
  if (!best || !clearMatch) {
    throw new Error(`Could not confidently identify the official website for "${companyName}". Enter the website URL instead.`);
  }

  return {
    url: normalizePublicUrl(best.result.url),
    warnings: [
      `INPUT RESOLUTION: Startup name "${companyName}" was matched to ${best.result.url}. Verify the company identity before relying on this analysis.`,
    ],
  };
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

async function extractCandidates(
  candidates: SearchCandidate[],
  query: string,
  idPrefix: string,
  companyTerm: string,
  signal?: AbortSignal,
) {
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
    if (!isSupportedEvidenceUrl(candidate.url)) return [];
    const rawContent = extracted.get(sourceKey(candidate.url));
    const excerpt = cleanTavilyContent(rawContent || candidate.content || "").slice(0, MAX_EXCERPT_CHARACTERS);
    if (!isUsefulEvidenceText(excerpt)) return [];
    if (candidate.scope === "independent" && !evidenceMentionsCompany(companyTerm, candidate.title, excerpt, candidate.url)) return [];
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

  const extracted = await extractCandidates(
    unique,
    `${domain} company product founders customers business model traction risks`,
    "tavily",
    companyTerm,
    signal,
  );

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

  const extracted = await extractCandidates(unique, `${companyTerm}: ${boundedQuestion}`, "chat", companyTerm, signal);
  return {
    sources: extracted.sources,
    warnings: [...warnings, ...extracted.warnings, `TAVILY CHAT SEARCH: ${extracted.sources.length} question-specific source(s) were added.`],
  };
}
