import { StartupSignal, type ModelOption } from "@/components/startup-signal";

export default function Home() {
  const modelOptions = [
    {
      provider: "cerebras",
      label: "Cerebras",
      model: process.env.CEREBRAS_MODEL || "gemma-4-31b",
      configured: Boolean(process.env.CEREBRAS_API_KEY),
    },
    {
      provider: "openai",
      label: "OpenAI",
      model: process.env.OPENAI_MODEL || "gpt-5.6-terra",
      configured: Boolean(process.env.OPENAI_API_KEY),
    },
    {
      provider: "anthropic",
      label: "Anthropic",
      model: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
      configured: Boolean(process.env.ANTHROPIC_API_KEY),
    },
  ] satisfies ModelOption[];

  return <StartupSignal modelOptions={modelOptions} />;
}
