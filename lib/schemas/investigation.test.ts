import { describe, expect, it } from "vitest";
import { demoScenarioUpdates, heliographDemo } from "@/lib/demo/heliograph";
import { AnalysisRequestSchema, ClaimSchema, InvestigationRunSchema, ScenarioUpdateSchema } from "@/lib/schemas/investigation";

describe("investigation schemas", () => {
  it("validates the complete demo packet", () => {
    const result = InvestigationRunSchema.safeParse(heliographDemo);
    expect(result.success).toBe(true);
    expect(heliographDemo.mode).toBe("demo");
    expect(heliographDemo.modelProvider).toBe("demo");
    expect(heliographDemo.profile.valuation).toMatchObject({
      amount: "$48M post-money",
      status: "reported",
      evidenceIds: ["ev-10"],
    });
    expect(heliographDemo.warnings.some((warning) => warning.includes("DEMO DATA"))).toBe(true);
  });

  it("defaults legacy live requests to Cerebras and accepts alternate providers", () => {
    expect(AnalysisRequestSchema.parse({ url: "OpenAI", mode: "live" }).provider).toBe("cerebras");
    expect(AnalysisRequestSchema.parse({ url: "OpenAI", mode: "live", provider: "openai" }).provider).toBe("openai");
    expect(AnalysisRequestSchema.parse({ url: "Anthropic", mode: "live", provider: "anthropic" }).provider).toBe("anthropic");
  });

  it("requires claim confidence to be bounded", () => {
    const invalid = { id: "c", text: "Unsupported", type: "inference", confidence: 1.5, evidenceIds: [], assumptions: [], agentId: "risk" };
    expect(ClaimSchema.safeParse(invalid).success).toBe(false);
  });

  it("requires structured probability updates in scenarios", () => {
    const invalid = { ...demoScenarioUpdates[0], probabilityUpdates: [{ scenarioId: "pmf", range: "20%" }] };
    expect(ScenarioUpdateSchema.safeParse(invalid).success).toBe(false);
  });
});
