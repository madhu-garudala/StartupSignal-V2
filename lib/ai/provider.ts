import "server-only";

import { anthropicModel, callAnthropicStructured } from "@/lib/ai/anthropic";
import { callCerebrasStructured, cerebrasModel, type StructuredRequest } from "@/lib/ai/cerebras";
import { callOpenAIStructured, openAIModel } from "@/lib/ai/openai";
import type { LiveModelProvider, ModelProvider } from "@/lib/schemas/investigation";

export function liveProvider(provider: ModelProvider): LiveModelProvider {
  return provider === "openai" || provider === "anthropic" ? provider : "cerebras";
}

export function providerModel(provider: LiveModelProvider) {
  if (provider === "anthropic") return anthropicModel();
  return provider === "openai" ? openAIModel() : cerebrasModel();
}

export function providerName(provider: LiveModelProvider) {
  if (provider === "anthropic") return "Anthropic";
  return provider === "openai" ? "OpenAI" : "Cerebras";
}

export function isProviderConfigured(provider: LiveModelProvider) {
  if (provider === "anthropic") return Boolean(process.env.ANTHROPIC_API_KEY);
  return provider === "openai" ? Boolean(process.env.OPENAI_API_KEY) : Boolean(process.env.CEREBRAS_API_KEY);
}

export function providerConfigurationError(provider: LiveModelProvider) {
  if (provider === "anthropic") return "Anthropic is selected but ANTHROPIC_API_KEY is not configured.";
  return provider === "openai"
    ? "OpenAI is selected but OPENAI_API_KEY is not configured."
    : "Cerebras is selected but CEREBRAS_API_KEY is not configured.";
}

export function callProviderStructured<T>(provider: LiveModelProvider, request: StructuredRequest<T>) {
  if (provider === "anthropic") return callAnthropicStructured(request);
  return provider === "openai" ? callOpenAIStructured(request) : callCerebrasStructured(request);
}
