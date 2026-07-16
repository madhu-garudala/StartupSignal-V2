import "server-only";

import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { StructuredRequest } from "@/lib/ai/cerebras";
import { withTransientProviderRetry } from "@/lib/ai/provider-retry";

const DEFAULT_MODEL = "gpt-5.6-terra";
const PRIMARY_TIMEOUT_MS = 42_000;
const REPAIR_TIMEOUT_MS = 12_000;
let cachedClient: OpenAI | null = null;

export function openAIModel() {
  return process.env.OPENAI_MODEL || DEFAULT_MODEL;
}

function client() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OpenAI analysis requires OPENAI_API_KEY. Select Cerebras or use demo mode instead.");
  if (!cachedClient) cachedClient = new OpenAI({ apiKey, timeout: PRIMARY_TIMEOUT_MS, maxRetries: 0 });
  return cachedClient;
}

function friendlyProviderError(error: unknown): never {
  const status = (error as { status?: number } | null)?.status;
  if (status === 429) throw new Error("OpenAI is temporarily rate limited. Retry shortly or select Cerebras.");
  if (typeof status === "number" && status >= 500) throw new Error("OpenAI is temporarily unavailable. Retry shortly or select Cerebras.");
  throw error;
}

async function createResponse<T>(
  request: StructuredRequest<T>,
  repairContext?: string,
) {
  const instructions = repairContext
    ? `${request.system}\nThe previous response failed validation (${repairContext}). Return corrected compact structured output only.`
    : request.system;
  const timeout = repairContext
    ? request.repairTimeoutMs ?? REPAIR_TIMEOUT_MS
    : request.primaryTimeoutMs ?? PRIMARY_TIMEOUT_MS;

  try {
    return await withTransientProviderRetry(
      () => client().responses.parse({
        model: openAIModel(),
        store: false,
        max_output_tokens: request.maxCompletionTokens,
        instructions,
        input: request.user,
        text: { format: zodTextFormat(request.validator, request.name) },
      }, { signal: request.signal, timeout }),
      { signal: request.signal },
    );
  } catch (error) {
    return friendlyProviderError(error);
  }
}

export async function callOpenAIStructured<T>(request: StructuredRequest<T>): Promise<T> {
  let response = await createResponse(request);
  let parsed = request.validator.safeParse(response.output_parsed);
  if (parsed.success) return parsed.data;

  const repairContext = parsed.error.issues.slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
    .join("; ");
  response = await createResponse(request, repairContext);
  parsed = request.validator.safeParse(response.output_parsed);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`OpenAI output failed validation after one repair attempt${issue ? ` at ${issue.path.join(".") || "root"}` : ""}.`);
  }
  return parsed.data;
}
