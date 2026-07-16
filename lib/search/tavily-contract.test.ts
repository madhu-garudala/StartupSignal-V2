import { describe, expect, it } from "vitest";
import {
  cleanTavilyContent,
  evidenceMentionsCompany,
  isExcludedOfficialWebsite,
  isSameSite,
  isSupportedEvidenceUrl,
  isUsefulEvidenceText,
  looksLikeWebsiteInput,
  rankOfficialWebsiteCandidates,
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

  it("distinguishes startup names from domains and full URLs", () => {
    expect(looksLikeWebsiteInput("OpenAI")).toBe(false);
    expect(looksLikeWebsiteInput("Scale AI")).toBe(false);
    expect(looksLikeWebsiteInput("gong.io")).toBe(true);
    expect(looksLikeWebsiteInput("https://openai.com/research")).toBe(true);
  });

  it("excludes directories and social platforms from official-site resolution", () => {
    expect(isExcludedOfficialWebsite("www.crunchbase.com")).toBe(true);
    expect(isExcludedOfficialWebsite("company.linkedin.com")).toBe(true);
    expect(isExcludedOfficialWebsite("openai.com")).toBe(false);
  });

  it("ranks a matching official domain above directories and articles", () => {
    const ranked = rankOfficialWebsiteCandidates("OpenAI", [
      { title: "OpenAI", url: "https://openai.com/", content: "OpenAI develops AI systems.", score: 0.91 },
      { title: "OpenAI company profile", url: "https://www.crunchbase.com/organization/openai", content: "OpenAI profile", score: 0.96 },
      { title: "Latest OpenAI coverage", url: "https://example-news.com/openai", content: "OpenAI coverage", score: 0.82 },
    ]);

    expect(ranked[0].hostname).toBe("openai.com");
    expect(ranked[0].exactDomain).toBe(true);
    expect(ranked.some((candidate) => candidate.hostname === "crunchbase.com")).toBe(false);
  });

  it("can identify official sites whose domain omits part of the company name", () => {
    const ranked = rankOfficialWebsiteCandidates("Scale AI", [
      { title: "Scale AI: The Data Foundry", url: "https://scale.com/", content: "Scale AI provides data infrastructure.", score: 0.88 },
      { title: "Scale AI news", url: "https://news.example.com/scale-ai", content: "News about Scale AI.", score: 0.82 },
    ]);

    expect(ranked[0].hostname).toBe("scale.com");
    expect(ranked[0].confidence).toBeGreaterThan(7.5);
  });

  it("allows Bloomberg's official domain while still excluding directories", () => {
    const ranked = rankOfficialWebsiteCandidates("Bloomberg", [
      { title: "Bloomberg", url: "https://www.bloomberg.com/", content: "Bloomberg company information.", score: 0.9 },
      { title: "Bloomberg Beta", url: "https://www.bloombergbeta.com/", content: "Bloomberg Beta venture capital.", score: 0.88 },
    ]);

    expect(ranked[0].hostname).toBe("bloomberg.com");
    expect(ranked[0].exactDomain).toBe(true);
  });

  it("rejects binary office documents and low-information extraction junk", () => {
    expect(isSupportedEvidenceUrl("https://example.com/company.xlsx")).toBe(false);
    expect(isSupportedEvidenceUrl("https://example.com/research.pdf")).toBe(true);
    expect(isUsefulEvidenceText("{@{@{@{@{@{H{H{H{H{D{D{D{D{L{L{L{L{")).toBe(false);
    expect(isUsefulEvidenceText("Tavily builds search infrastructure for AI applications. Its platform retrieves current public web evidence and returns normalized results for developers building research workflows.")).toBe(true);
  });

  it("requires independent evidence to mention the active company", () => {
    expect(evidenceMentionsCompany("Bloomberg", "Company profile", "Bloomberg provides financial data.", "https://example.com/report")).toBe(true);
    expect(evidenceMentionsCompany("Bloomberg", "Blockchain report", "InfoSum provides data collaboration software.", "https://example.com/report.pdf")).toBe(false);
  });
});
