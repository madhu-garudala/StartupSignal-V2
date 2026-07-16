import { describe, expect, it } from "vitest";
import { checkRateLimit, requestClientKey } from "@/lib/security/rate-limit";

describe("requestClientKey", () => {
  it("prefers Vercel's forwarding header over proxy fallbacks", () => {
    const request = new Request("https://example.com", {
      headers: {
        "x-vercel-forwarded-for": "203.0.113.10",
        "x-real-ip": "203.0.113.11",
        "x-forwarded-for": "203.0.113.12, 10.0.0.1",
      },
    });

    expect(requestClientKey(request)).toBe("203.0.113.10");
  });

  it("uses only the first forwarded address as a fallback", () => {
    const request = new Request("https://example.com", {
      headers: { "x-forwarded-for": "203.0.113.12, 10.0.0.1" },
    });

    expect(requestClientKey(request)).toBe("203.0.113.12");
  });
});

describe("checkRateLimit", () => {
  it("rejects calls beyond the configured window limit", () => {
    const key = `test-${crypto.randomUUID()}`;

    expect(checkRateLimit(key, 2).allowed).toBe(true);
    expect(checkRateLimit(key, 2).allowed).toBe(true);
    expect(checkRateLimit(key, 2).allowed).toBe(false);
  });
});
