import { describe, expect, it } from "vitest";
import { heliographDemo } from "@/lib/demo/heliograph";
import { ResearchChatAnswerSchema, ResearchChatRequestSchema } from "@/lib/schemas/research-chat";

describe("research chat schemas", () => {
  it("accepts a bounded contextual question", () => {
    const result = ResearchChatRequestSchema.parse({
      run: heliographDemo,
      messages: [{ role: "user", content: "What is the largest risk?" }],
      question: "How would a slower sales cycle change the thesis?",
    });
    expect(result.run.profile.name).toBe("Heliograph");
  });

  it("rejects oversized conversation history", () => {
    const messages = Array.from({ length: 9 }, () => ({ role: "user" as const, content: "Question" }));
    expect(ResearchChatRequestSchema.safeParse({ run: heliographDemo, messages, question: "What changed?" }).success).toBe(false);
  });

  it("requires a structured uncertainty-aware answer", () => {
    expect(ResearchChatAnswerSchema.parse({
      answer: "A 20-35% range is defensible from the supplied evidence.",
      confidence: "low",
      forecast: { probabilityRange: "20-35%", horizon: "12 months", basis: "No stated listing plan." },
      evidenceIds: ["ev-1"],
      assumptions: ["Market conditions remain stable."],
      unknowns: ["Board intent is unknown."],
      followUpQuestions: ["What would raise the estimate?"],
    }).confidence).toBe("low");
  });
});
