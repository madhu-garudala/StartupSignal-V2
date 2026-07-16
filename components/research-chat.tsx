"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, CircleHelp, ExternalLink, LoaderCircle, MessageSquareText, Send, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  ResearchChatResponseSchema,
  type ResearchChatMessage,
  type ResearchChatResponse,
} from "@/lib/schemas/research-chat";
import type { InvestigationRun } from "@/lib/schemas/investigation";

type ChatTurn = ResearchChatMessage & { id: string; response?: ResearchChatResponse };

const promptOptions = [
  "What are the odds they go public in the next year?",
  "What is the strongest evidence against the verdict?",
  "Which diligence gap matters most?",
];

export function ResearchChat({ run }: { run: InvestigationRun }) {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, pending]);

  async function ask(value = input) {
    const question = value.trim();
    if (pending || question.length < 3) return;
    const history = turns.slice(-8).map(({ role, content }) => ({ role, content }));
    setTurns((current) => [...current, { id: crypto.randomUUID(), role: "user", content: question }]);
    setInput("");
    setError(null);
    setPending(true);
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run, messages: history, question }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "The research channel could not answer.");
      const parsed = ResearchChatResponseSchema.parse(payload);
      setTurns((current) => [...current, {
        id: crypto.randomUUID(),
        role: "assistant",
        content: parsed.answer.answer,
        response: parsed,
      }]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The research channel failed safely.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="focus-ring no-print fixed bottom-4 right-4 z-40 flex h-11 items-center gap-2 border border-[#31545a] bg-[#0d171a] px-4 text-xs font-semibold text-[#dce8ea] shadow-[0_12px_45px_rgba(0,0,0,.45)] hover:border-[#47757b]"
        aria-label={`Open ${run.profile.name} research channel`}
      >
        <MessageSquareText size={16} className="text-[var(--cyan)]" /> Research channel
      </button>

      <AnimatePresence>
        {open && (
          <motion.aside
            role="dialog"
            aria-label={`${run.profile.name} research channel`}
            initial={{ opacity: 0, y: 12, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.99 }}
            transition={{ duration: 0.18 }}
            className="no-print fixed bottom-4 right-4 z-50 flex h-[min(650px,calc(100vh-32px))] w-[min(430px,calc(100vw-32px))] flex-col overflow-hidden border border-[#2b383d] bg-[#090c0e] shadow-[0_24px_80px_rgba(0,0,0,.7)]"
          >
            <header className="flex h-16 shrink-0 items-center gap-3 border-b border-[#253036] px-4">
              <div className="grid size-8 place-items-center border border-[#31545a] bg-[#102025]">
                <MessageSquareText size={15} className="text-[var(--cyan)]" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="mono text-[9px] uppercase text-[#718087]">Research channel</div>
                <div className="mt-1 truncate text-xs font-semibold text-white">Context: {run.profile.name}</div>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="focus-ring grid size-8 place-items-center text-[#7e8b91] hover:text-white" title="Close research channel">
                <X size={16} />
              </button>
            </header>

            <div className="fine-scroll flex-1 overflow-y-auto px-4 py-4" aria-live="polite">
              {!turns.length && (
                <div className="space-y-2">
                  {promptOptions.map((prompt) => (
                    <button key={prompt} type="button" onClick={() => ask(prompt)} className="focus-ring flex w-full items-center justify-between gap-3 border border-[#263136] bg-[#0c1012] px-3 py-3 text-left text-xs leading-5 text-[#aeb8bd] hover:border-[#385159] hover:text-white">
                      <span>{prompt}</span><ArrowRight size={13} className="shrink-0 text-[var(--cyan)]" />
                    </button>
                  ))}
                </div>
              )}

              <div className="space-y-5">
                {turns.map((turn) => turn.role === "user" ? (
                  <div key={turn.id} className="ml-8 border-r-2 border-[#39656b] bg-[#10191b] px-3 py-2.5 text-xs leading-5 text-[#d4dcdf]">
                    {turn.content}
                  </div>
                ) : (
                  <article key={turn.id} className="border-l-2 border-[#344147] pl-3">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <span className="mono text-[8px] uppercase text-[var(--cyan)]">StartupSignal intelligence</span>
                      <span className="mono text-[8px] uppercase text-[#78868c]">{turn.response?.answer.confidence} confidence</span>
                    </div>
                    <p className="whitespace-pre-wrap text-xs leading-5 text-[#bdc7cb]">{turn.content}</p>
                    {turn.response?.answer.forecast && (
                      <div className="mt-3 grid grid-cols-[100px_1fr] border border-[#2b3b40] bg-[#0d1416]">
                        <div className="border-r border-[#2b3b40] p-3">
                          <div className="mono text-[8px] uppercase text-[#69767c]">Probability</div>
                          <div className="mt-1 text-lg font-semibold text-white">{turn.response.answer.forecast.probabilityRange}</div>
                          <div className="mt-1 text-[9px] text-[#718087]">{turn.response.answer.forecast.horizon}</div>
                        </div>
                        <p className="p-3 text-[10px] leading-4 text-[#8f9ca2]">{turn.response.answer.forecast.basis}</p>
                      </div>
                    )}
                    {!!turn.response?.answer.assumptions.length && (
                      <div className="mt-3 border-t border-[#20282c] pt-3">
                        <div className="mono text-[8px] uppercase text-[#69767c]">Assumptions</div>
                        {turn.response.answer.assumptions.map((item) => <p key={item} className="mt-1.5 text-[10px] leading-4 text-[#87949a]">{item}</p>)}
                      </div>
                    )}
                    {!!turn.response?.answer.unknowns.length && (
                      <div className="mt-3 flex gap-2 border border-[#3b3427] bg-[#15130f] p-2.5 text-[10px] leading-4 text-[#a99b7e]">
                        <CircleHelp size={13} className="mt-0.5 shrink-0 text-[var(--amber)]" />
                        <div>{turn.response.answer.unknowns.join(" ")}</div>
                      </div>
                    )}
                    {!!turn.response?.sources.length && (
                      <div className="mt-3 space-y-1.5">
                        <div className="mono text-[8px] uppercase text-[#69767c]">Cited evidence</div>
                        {turn.response.sources.map((source) => (
                          <a key={source.id} href={source.url} target="_blank" rel="noreferrer noopener" className="focus-ring flex items-start justify-between gap-2 text-[10px] leading-4 text-[#8fa0a6] hover:text-[var(--cyan)]">
                            <span>{source.title}</span><ExternalLink size={10} className="mt-0.5 shrink-0" />
                          </a>
                        ))}
                      </div>
                    )}
                    {!!turn.response?.answer.followUpQuestions.length && (
                      <div className="mt-4 space-y-1">
                        {turn.response.answer.followUpQuestions.map((followUp) => (
                          <button key={followUp} type="button" onClick={() => ask(followUp)} className="focus-ring flex w-full items-start gap-2 py-1 text-left text-[10px] leading-4 text-[#7f8c92] hover:text-white">
                            <ArrowRight size={11} className="mt-0.5 shrink-0 text-[var(--cyan)]" />{followUp}
                          </button>
                        ))}
                      </div>
                    )}
                  </article>
                ))}
                {pending && <div className="flex items-center gap-2 text-xs text-[#829097]"><LoaderCircle size={14} className="animate-spin text-[var(--cyan)]" />Retrieving evidence and testing the thesis</div>}
                {error && <div className="border border-[#5b302e] bg-[#211313] p-3 text-xs leading-5 text-[#f2a29d]">{error}</div>}
                <div ref={endRef} />
              </div>
            </div>

            <form onSubmit={(event) => { event.preventDefault(); void ask(); }} className="shrink-0 border-t border-[#253036] p-3">
              <div className="flex items-end gap-2 border border-[#2b373c] bg-[#0c1012] p-2 focus-within:border-[#3d656c]">
                <textarea
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void ask(); }
                  }}
                  maxLength={500}
                  rows={2}
                  placeholder={`Ask about ${run.profile.name}`}
                  className="fine-scroll min-h-10 flex-1 resize-none bg-transparent px-1 py-1 text-xs leading-5 text-white outline-none placeholder:text-[#5e6b71]"
                  aria-label={`Ask about ${run.profile.name}`}
                />
                <button type="submit" disabled={pending || input.trim().length < 3} className="focus-ring grid size-9 shrink-0 place-items-center bg-[var(--cyan)] text-[#071013] disabled:cursor-not-allowed disabled:opacity-30" title="Send question">
                  <Send size={15} />
                </button>
              </div>
            </form>
          </motion.aside>
        )}
      </AnimatePresence>
    </>
  );
}
