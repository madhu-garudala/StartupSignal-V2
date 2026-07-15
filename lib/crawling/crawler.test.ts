import { describe, expect, it } from "vitest";
import { parseSitemap, readBoundedBody } from "@/lib/crawling/crawler";

describe("readBoundedBody", () => {
  it("returns a complete body below the configured limit", async () => {
    const result = await readBoundedBody(new Response("startup signal"), 32);

    expect(result).toEqual({ text: "startup signal", truncated: false, bytesRead: 14 });
  });

  it("retains only the bounded prefix and cancels oversized content", async () => {
    const result = await readBoundedBody(new Response("0123456789oversized"), 10);

    expect(result).toEqual({ text: "0123456789", truncated: true, bytesRead: 10 });
  });

  it("applies the limit in bytes rather than JavaScript characters", async () => {
    const result = await readBoundedBody(new Response("ééé"), 4);

    expect(new TextEncoder().encode(result.text).byteLength).toBe(4);
    expect(result.truncated).toBe(true);
  });
});

describe("parseSitemap", () => {
  it("keeps only same-origin sitemap and page entries", () => {
    const parsed = parseSitemap(`<?xml version="1.0"?>
      <sitemapindex><sitemap><loc>https://example.com/company.xml</loc></sitemap><sitemap><loc>https://other.test/leak.xml</loc></sitemap></sitemapindex>`, new URL("https://example.com/sitemap.xml"));
    const pages = parseSitemap(`<?xml version="1.0"?>
      <urlset><url><loc>https://example.com/about</loc><lastmod>2026-07-01</lastmod></url><url><loc>https://other.test/about</loc></url></urlset>`, new URL("https://example.com/company.xml"));

    expect(parsed.sitemaps.map(String)).toEqual(["https://example.com/company.xml"]);
    expect(pages.pages).toEqual([{ url: new URL("https://example.com/about"), lastModified: "2026-07-01" }]);
  });
});
