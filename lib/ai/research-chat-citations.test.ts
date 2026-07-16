import { describe, expect, it } from "vitest";
import { inlineEvidenceIds, sanitizeInlineCitations } from "@/lib/ai/research-chat-citations";

describe("research chat citations", () => {
  it("keeps supplied evidence IDs and removes unsupported citation tokens", () => {
    const answer = sanitizeInlineCitations(
      "The filing is reported [ev-chat-2], but intent is unknown [currentInvestigation.verdict].",
      new Set(["ev-chat-2"]),
    );
    expect(answer).toBe("The filing is reported [ev-chat-2], but intent is unknown.");
    expect(inlineEvidenceIds(answer)).toEqual(["ev-chat-2"]);
  });
});
