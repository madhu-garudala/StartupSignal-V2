import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { StructuredRequest } from "@/lib/ai/cerebras";
import { withTransientProviderRetry } from "@/lib/ai/provider-retry";

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const PRIMARY_TIMEOUT_MS = 42_000;
const REPAIR_TIMEOUT_MS = 12_000;
let cachedClient: Anthropic | null = null;

export function anthropicModel() {
  return process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
}

function client() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Anthropic analysis requires ANTHROPIC_API_KEY. Select another provider or use demo mode instead.");
  if (!cachedClient) cachedClient = new Anthropic({ apiKey, timeout: PRIMARY_TIMEOUT_MS, maxRetries: 0 });
  return cachedClient;
}

function friendlyProviderError(error: unknown): never {
  const status = (error as { status?: number } | null)?.status;
  if (status === 429) throw new Error("Anthropic is temporarily rate limited. Retry shortly or select another provider.");
  if (typeof status === "number" && status >= 500) throw new Error("Anthropic is temporarily unavailable. Retry shortly or select another provider.");
  throw error;
}

async function createMessage<T>(request: StructuredRequest<T>, repairContext?: string) {
  const system = repairContext
    ? `${request.system}\nThe previous response failed validation (${repairContext}). Return corrected compact structured output only.`
    : request.system;
  const timeout = repairContext
    ? request.repairTimeoutMs ?? REPAIR_TIMEOUT_MS
    : request.primaryTimeoutMs ?? PRIMARY_TIMEOUT_MS;

  try {
    return await withTransientProviderRetry(
      () => client().messages.parse({
        model: anthropicModel(),
        max_tokens: request.maxCompletionTokens,
        temperature: 0.1,
        system,
        messages: [{ role: "user", content: request.user }],
        output_config: { format: zodOutputFormat(request.validator) },
      }, { signal: request.signal, timeout }),
      { signal: request.signal },
    );
  } catch (error) {
    return friendlyProviderError(error);
  }
}

export async function callAnthropicStructured<T>(request: StructuredRequest<T>): Promise<T> {
  let response = await createMessage(request);
  let parsed = request.validator.safeParse(response.parsed_output);
  if (parsed.success) return parsed.data;

  const repairContext = parsed.error.issues.slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
    .join("; ");
  response = await createMessage(request, repairContext);
  parsed = request.validator.safeParse(response.parsed_output);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Anthropic output failed validation after one repair attempt${issue ? ` at ${issue.path.join(".") || "root"}` : ""}.`);
  }
  return parsed.data;
}
