import { describe, expect, it } from "vitest";
import { z } from "zod";
import { cerebrasJsonSchema, extractJsonObject } from "@/lib/ai/cerebras-schema";

describe("cerebrasJsonSchema", () => {
  it("makes every object strict and removes unsupported constraints", () => {
    const schema = cerebrasJsonSchema(z.object({
      name: z.string().min(2).max(40),
      title: z.string(),
      description: z.string(),
      items: z.array(z.object({ url: z.url(), tags: z.array(z.string()).min(1) })).min(1),
    }));
    const encoded = JSON.stringify(schema);

    expect(schema.additionalProperties).toBe(false);
    expect(encoded).not.toContain("minLength");
    expect(encoded).not.toContain("maxItems");
    expect(encoded).not.toContain("format");
    expect(encoded).toContain('"title"');
    expect(encoded).toContain('"description"');
    expect(encoded.match(/additionalProperties/g)).toHaveLength(2);
  });

  it("rejects schemas beyond Cerebras's strict-output limit", () => {
    const values = Array.from({ length: 600 }, (_, index) => `value-${index}`) as [string, ...string[]];
    expect(() => cerebrasJsonSchema(z.object({ value: z.enum(values) }))).toThrow(/5,000-character/);
  });
});

describe("extractJsonObject", () => {
  it("removes prose and markdown surrounding a JSON object", () => {
    expect(extractJsonObject("Result:\n```json\n{\"ok\":true}\n```"))
      .toBe('{"ok":true}');
  });
});
