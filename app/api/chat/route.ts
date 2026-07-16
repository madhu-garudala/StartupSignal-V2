import { answerResearchQuestion } from "@/lib/ai/research-chat";
import { isProviderConfigured, liveProvider, providerConfigurationError } from "@/lib/ai/provider";
import { ResearchChatRequestSchema } from "@/lib/schemas/research-chat";
import { checkRateLimit, requestClientKey } from "@/lib/security/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 45;

export async function POST(request: Request) {
  const ip = requestClientKey(request);
  if (!checkRateLimit(`chat:${ip}`, 12).allowed) {
    return Response.json({ error: "Research-channel limit reached. Try again shortly." }, { status: 429 });
  }
  const body = ResearchChatRequestSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "A valid investigation and bounded question are required." }, { status: 400 });
  if (body.data.run.mode !== "live" || body.data.run.status !== "complete") {
    return Response.json({ error: "Research chat requires a completed live investigation." }, { status: 400 });
  }
  const provider = liveProvider(body.data.run.modelProvider);
  if (!isProviderConfigured(provider)) return Response.json({ error: providerConfigurationError(provider) }, { status: 503 });

  try {
    return Response.json(await answerResearchQuestion(body.data.run, body.data.messages, body.data.question, request.signal));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Research answer failed safely." }, { status: 500 });
  }
}
