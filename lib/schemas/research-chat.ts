import { z } from "zod";
import { InvestigationRunSchema, ReliabilitySchema } from "@/lib/schemas/investigation";

export const ResearchChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(4_000),
});

export const ResearchChatRequestSchema = z.object({
  run: InvestigationRunSchema,
  messages: z.array(ResearchChatMessageSchema).max(8),
  question: z.string().trim().min(3).max(500),
});

export const ResearchChatAnswerSchema = z.object({
  answer: z.string().min(1).max(4_000),
  confidence: ReliabilitySchema,
  forecast: z.object({
    probabilityRange: z.string().min(1),
    horizon: z.string().min(1),
    basis: z.string().min(1),
  }).nullable(),
  evidenceIds: z.array(z.string()).max(8),
  assumptions: z.array(z.string()).max(4),
  unknowns: z.array(z.string()).max(4),
  followUpQuestions: z.array(z.string()).max(3),
});

export const ResearchChatSourceSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.url(),
  sourceType: z.string(),
  reliability: ReliabilitySchema,
});

export const ResearchChatResponseSchema = z.object({
  answer: ResearchChatAnswerSchema,
  sources: z.array(ResearchChatSourceSchema),
  searchedAt: z.string(),
});

export type ResearchChatMessage = z.infer<typeof ResearchChatMessageSchema>;
export type ResearchChatResponse = z.infer<typeof ResearchChatResponseSchema>;
