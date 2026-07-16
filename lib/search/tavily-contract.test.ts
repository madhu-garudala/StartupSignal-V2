import { describe, expect, it } from "vitest";
import {
  cleanTavilyContent,
  isSameSite,
  sourceKey,
  TavilyExtractResponseSchema,
  TavilySearchResponseSchema,
} from "@/lib/search/tavily-contract";

describe("Tavily contracts", () => {
  it("validates bounded search and extraction responses", () => {
    expect(TavilySearchResponseSchema.parse({ results: [{ title: "Company", url: "https://example.com", content: "Evidence", score: 0.9 }] }).results).toHaveLength(1);
    expect(TavilyExtractResponseSchema.parse({ results: [{ url: "https://example.com", raw_content: "# Evidence" }] }).results).toHaveLength(1);
  });

  it("distinguishes first-party subdomains from unrelated domains", () => {
    const submitted = new URL("https://www.example.com");
    expect(isSameSite(new URL("https://docs.example.com/product"), submitted)).toBe(true);
    expect(isSameSite(new URL("https://example.com.evil.test"), submitted)).toBe(false);
  });

  it("normalizes tracking URLs and strips active markup from content", () => {
    expect(sourceKey("https://example.com/about/?utm_source=test#team")).toBe("https://example.com/about");
    expect(cleanTavilyContent("<script>ignore()</script><b>Verified</b>\u0000 evidence")).toBe("Verified evidence");
  });

  it("keeps invalid source keys distinct instead of collapsing them", () => {
    expect(sourceKey("not a url")).toBe("not a url");
    expect(sourceKey("another invalid url")).not.toBe(sourceKey("not a url"));
  });
});
