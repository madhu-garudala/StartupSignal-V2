"use client";

import { useRef, useState } from "react";
import { Landing } from "@/components/landing";
import { Workspace, type StageState, type WorkspaceTab } from "@/components/workspace";
import { InvestigationEventSchema } from "@/lib/orchestration/events";
import { InvestigationRunSchema, type AgentReport, type CommitteeStatement, type EvidenceItem, type InvestigationRun } from "@/lib/schemas/investigation";

export function StartupSignal() {
  const [view, setView] = useState<"landing" | "workspace">("landing");
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<"demo" | "live">("demo");
  const [run, setRun] = useState<InvestigationRun | null>(null);
  const [stages, setStages] = useState<Record<string, StageState>>({});
  const [agents, setAgents] = useState<AgentReport[]>([]);
  const [evidence, setEvidence] = useState<EvidenceItem[]>([]);
  const [committee, setCommittee] = useState<CommitteeStatement[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("investigation");
  const startLock = useRef(false);
  const activeRequest = useRef<AbortController | null>(null);

  async function start(selectedMode: "demo" | "live") {
    if (startLock.current) return;
    const target = selectedMode === "demo" ? "https://demo.startupsignal.dev/heliograph" : url.trim();
    if (selectedMode === "live" && !target) {
      setError("Enter a startup name or website.");
      return;
    }
    startLock.current = true;
    const requestController = new AbortController();
    activeRequest.current = requestController;
    setMode(selectedMode);
    setView("workspace");
    setRun(null);
    setStages({});
    setAgents([]);
    setEvidence([]);
    setCommittee([]);
    setError(null);
    setRunning(true);
    setActiveTab("investigation");

    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: target, mode: selectedMode }),
        signal: requestController.signal,
      });
      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "The investigation could not start.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let terminalEvent = false;
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const raw of lines) {
          if (!raw.trim()) continue;
          let value: unknown;
          try { value = JSON.parse(raw); } catch { continue; }
          const parsed = InvestigationEventSchema.safeParse(value);
          if (!parsed.success) continue;
          const event = parsed.data;
          if (event.type === "stage") setStages((current) => ({ ...current, [event.stageId]: { status: event.status, message: event.message } }));
          if (event.type === "agent") setAgents((current) => current.some((item) => item.id === event.agentId) ? current : [...current, event.agent]);
          if (event.type === "evidence") setEvidence((current) => current.some((item) => item.id === event.evidenceId) ? current : [...current, event.evidence]);
          if (event.type === "committee") setCommittee((current) => current.some((item) => item.id === event.statementId) ? current : [...current, event.statement]);
          if (event.type === "error") {
            terminalEvent = true;
            setError(event.message);
          }
          if (event.type === "complete") {
            const validated = InvestigationRunSchema.safeParse(event.run);
            if (validated.success) {
              terminalEvent = true;
              setRun(validated.data);
              setAgents(validated.data.agents);
              setEvidence(validated.data.evidence);
              setCommittee(validated.data.committee);
            }
          }
        }
        if (done) break;
      }
      if (!terminalEvent) throw new Error("The investigation stream ended before a final result was delivered.");
    } catch (cause) {
      if (!requestController.signal.aborted) setError(cause instanceof Error ? cause.message : "The investigation failed safely.");
    } finally {
      if (activeRequest.current === requestController) activeRequest.current = null;
      startLock.current = false;
      setRunning(false);
    }
  }

  function reset() {
    activeRequest.current?.abort();
    activeRequest.current = null;
    startLock.current = false;
    setView("landing");
    setRun(null);
    setError(null);
    setRunning(false);
  }

  if (view === "landing") return <Landing url={url} setUrl={setUrl} error={error} onAnalyze={() => start("live")} onDemo={() => start("demo")} />;
  return (
    <Workspace
      mode={mode}
      targetUrl={mode === "demo" ? "heliograph.energy" : url}
      running={running}
      run={run}
      setRun={setRun}
      stages={stages}
      agents={agents}
      evidence={evidence}
      committee={committee}
      error={error}
      tab={activeTab}
      setTab={setActiveTab}
      onReset={reset}
      onRetry={() => start("live")}
      onDemo={() => start("demo")}
    />
  );
}
