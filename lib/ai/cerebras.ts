import "server-only";

import Cerebras from "@cerebras/cerebras_cloud_sdk";
import type { ZodType } from "zod";
import { cerebrasJsonSchema, extractJsonObject } from "@/lib/ai/cerebras-schema";
import { withTransientProviderRetry } from "@/lib/ai/provider-retry";

const DEFAULT_MODEL = "gemma-4-31b";
const PRIMARY_TIMEOUT_MS = 22_000;
const REPAIR_TIMEOUT_MS = 14_000;
let cachedClient: Cerebras | null = null;

export function cerebrasModel() {
  return process.env.CEREBRAS_MODEL || DEFAULT_MODEL;
}

function client() {
  const apiKey = process.env.CEREBRAS_API_KEY;
  if (!apiKey) throw new Error("Live analysis requires CEREBRAS_API_KEY. Demo mode works without it.");
  if (!cachedClient) cachedClient = new Cerebras({ apiKey, timeout: PRIMARY_TIMEOUT_MS, maxRetries: 0 });
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

function friendlyProviderError(error: unknown): never {
  const status = (error as { status?: number } | null)?.status;
  if (status === 429) {
    throw new Error("Cerebras is temporarily at capacity. Please retry the investigation in a moment.");
  }
  if (typeof status === "number" && status >= 500) {
    throw new Error("Cerebras is temporarily unavailable. Please retry the investigation shortly.");
  }
  throw error;
}

async function createCompletion(
  parameters: Parameters<ReturnType<typeof client>["chat"]["completions"]["create"]>[0],
  signal: AbortSignal | undefined,
  timeout: number,
) {
  try {
    return await withTransientProviderRetry(
      () => client().chat.completions.create(parameters, { signal, timeout }),
      { signal },
    );
  } catch (error) {
    return friendlyProviderError(error);
  }
}

export type StructuredRequest<T> = {
  name: string;
  validator: ZodType<T>;
  system: string;
  user: string;
  maxCompletionTokens: number;
  signal?: AbortSignal;
  primaryTimeoutMs?: number;
  repairTimeoutMs?: number;
};

export async function callCerebrasStructured<T>({
  name,
  validator,
  system,
  user,
  maxCompletionTokens,
  signal,
  primaryTimeoutMs = PRIMARY_TIMEOUT_MS,
  repairTimeoutMs = REPAIR_TIMEOUT_MS,
}: StructuredRequest<T>): Promise<T> {
  const schema = cerebrasJsonSchema(validator);
  const base = {
    model: cerebrasModel(),
    max_completion_tokens: maxCompletionTokens,
    temperature: 0.15,
    top_p: 1,
    response_format: { type: "json_schema" as const, json_schema: { name, strict: true, schema } },
  };

  let response = await createCompletion({
    ...base,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  }, signal, primaryTimeoutMs);
  let raw = responseContent(response);
  let parsed = parseResponse(raw, validator);
  if (parsed.success) return parsed.data;
  const repairContext = parsed.error.issues.slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
    .join("; ");

  response = await createCompletion({
    ...base,
    temperature: 0.1,
    response_format: { type: "json_schema" as const, json_schema: { name, strict: false, schema } },
    messages: [
      {
        role: "system",
        content: `${system}\nThe previous response failed validation (${repairContext}). Return corrected compact JSON only. Do not emit markdown or repeat keys.`,
      },
      { role: "user", content: user },
    ],
  }, signal, repairTimeoutMs);
  raw = responseContent(response);
  parsed = parseResponse(raw, validator);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Cerebras output failed validation after one repair attempt${issue ? ` at ${issue.path.join(".") || "root"}` : ""}.`);
  }
  return parsed.data;
}
