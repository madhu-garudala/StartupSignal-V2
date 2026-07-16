import { answerResearchQuestion } from "@/lib/ai/research-chat";
import { ResearchChatRequestSchema } from "@/lib/schemas/research-chat";
import { checkRateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 45;

export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!checkRateLimit(`chat:${ip}`, 12).allowed) {
    return Response.json({ error: "Research-channel limit reached. Try again shortly." }, { status: 429 });
  }
  const body = ResearchChatRequestSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "A valid investigation and bounded question are required." }, { status: 400 });
  if (!process.env.CEREBRAS_API_KEY) return Response.json({ error: "Research chat requires CEREBRAS_API_KEY." }, { status: 503 });

  try {
    return Response.json(await answerResearchQuestion(body.data.run, body.data.messages, body.data.question));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Research answer failed safely." }, { status: 500 });
  }
}
