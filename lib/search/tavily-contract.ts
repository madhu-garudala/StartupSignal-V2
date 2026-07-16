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

export function baseHostname(hostname: string) {
  return hostname.toLowerCase().replace(/^www\./, "");
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
