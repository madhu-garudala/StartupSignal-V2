import "server-only";

import Cerebras from "@cerebras/cerebras_cloud_sdk";
import type { ZodType } from "zod";
import { cerebrasJsonSchema, extractJsonObject } from "@/lib/ai/cerebras-schema";

const DEFAULT_MODEL = "gemma-4-31b";
let cachedClient: Cerebras | null = null;

export function cerebrasModel() {
  return process.env.CEREBRAS_MODEL || DEFAULT_MODEL;
}

function client() {
  const apiKey = process.env.CEREBRAS_API_KEY;
  if (!apiKey) throw new Error("Live analysis requires CEREBRAS_API_KEY. Demo mode works without it.");
  if (!cachedClient) cachedClient = new Cerebras({ apiKey, timeout: 50_000, maxRetries: 0 });
  return cachedClient;
}

function parseResponse<T>(raw: string, validator: ZodType<T>) {
  try {
    return validator.safeParse(JSON.parse(extractJsonObject(raw)));
  } catch {
    return validator.safeParse(null);
  }
}

function responseContent(response: unknown) {
  const content = (response as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("Cerebras returned no analysis content.");
  return content;
}

type StructuredRequest<T> = {
  name: string;
  validator: ZodType<T>;
  system: string;
  user: string;
  maxCompletionTokens: number;
};

export async function callCerebrasStructured<T>({
  name,
  validator,
  system,
  user,
  maxCompletionTokens,
}: StructuredRequest<T>): Promise<T> {
  const schema = cerebrasJsonSchema(validator);
  const base = {
    model: cerebrasModel(),
    max_completion_tokens: maxCompletionTokens,
    temperature: 0.15,
    top_p: 1,
    response_format: { type: "json_schema" as const, json_schema: { name, strict: true, schema } },
  };

  let response = await client().chat.completions.create({
    ...base,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  let raw = responseContent(response);
  let parsed = parseResponse(raw, validator);
  if (parsed.success) return parsed.data;

  response = await client().chat.completions.create({
    ...base,
    temperature: 0.35,
    response_format: { type: "json_schema" as const, json_schema: { name, strict: false, schema } },
    messages: [
      {
        role: "system",
        content: `${system}\nReturn only compact JSON matching the schema. Do not emit markdown or repeat keys.`,
      },
      { role: "user", content: user },
    ],
  });
  raw = responseContent(response);
  parsed = parseResponse(raw, validator);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Cerebras output failed validation after one repair attempt${issue ? ` at ${issue.path.join(".") || "root"}` : ""}.`);
  }
  return parsed.data;
}
