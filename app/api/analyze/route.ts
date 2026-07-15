import { analyzeSources } from "@/lib/ai/live-analysis";
import { crawlCompany } from "@/lib/crawling/crawler";
import { heliographDemo } from "@/lib/demo/heliograph";
import { pipelineStages, type InvestigationEvent } from "@/lib/orchestration/events";
import { AnalysisRequestSchema, InvestigationRunSchema, type InvestigationRun } from "@/lib/schemas/investigation";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { assertPublicDestination, normalizePublicUrl, UrlSecurityError } from "@/lib/security/url";
import { sourceKey } from "@/lib/search/tavily-contract";
import { searchCompanyEvidence } from "@/lib/search/tavily";

export const runtime = "nodejs";
export const maxDuration = 60;

const encoder = new TextEncoder();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function line(event: InvestigationEvent) {
  return encoder.encode(`${JSON.stringify(event)}\n`);
}

export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!checkRateLimit(ip).allowed) return Response.json({ error: "Too many investigations. Try again in a minute." }, { status: 429 });
  const body = AnalysisRequestSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "A valid URL and analysis mode are required." }, { status: 400 });

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: InvestigationEvent) => controller.enqueue(line(event));
      const runId = body.data.mode === "demo" ? heliographDemo.id : `live-${crypto.randomUUID()}`;
      send({ type: "run_started", runId, mode: body.data.mode, url: body.data.url });
      try {
        if (body.data.mode === "demo") {
          for (let index = 0; index < pipelineStages.length; index += 1) {
            const stage = pipelineStages[index];
            send({ type: "stage", stageId: stage.id, status: "running", message: `Investigating ${stage.label.toLowerCase()}` });
            const agent = heliographDemo.agents.find((item) => item.stage === stage.id);
            if (agent) send({ type: "agent", agentId: agent.id, agent });
            const item = heliographDemo.evidence[index % heliographDemo.evidence.length];
            if (index < heliographDemo.evidence.length) send({ type: "evidence", evidenceId: item.id, evidence: item });
            if (stage.id === "committee") for (const statement of heliographDemo.committee.slice(0, 4)) send({ type: "committee", statementId: statement.id, statement });
            await sleep(index < 3 ? 260 : 150);
            send({ type: "stage", stageId: stage.id, status: stage.id === "customers" ? "low_evidence" : "complete", message: stage.id === "customers" ? "Limited independent evidence" : `${stage.label} complete` });
          }
          for (const statement of heliographDemo.committee.slice(4)) send({ type: "committee", statementId: statement.id, statement });
          send({ type: "complete", run: heliographDemo });
        } else {
          send({ type: "stage", stageId: "discovery", status: "running", message: "Validating destination and robots policy" });
          const submitted = normalizePublicUrl(body.data.url);
          await assertPublicDestination(submitted);
          send({ type: "stage", stageId: "market", status: "running", message: "Searching bounded first-party and independent evidence" });
          const [crawlAttempt, searchAttempt] = await Promise.allSettled([
            crawlCompany(submitted.toString()),
            searchCompanyEvidence(submitted.toString()),
          ]);

          const crawled = crawlAttempt.status === "fulfilled" ? crawlAttempt.value : null;
          const searched = searchAttempt.status === "fulfilled"
            ? searchAttempt.value
            : { sources: [], warnings: ["TAVILY FAILURE: Search enrichment was unavailable."] };
          const crawlWarnings = crawlAttempt.status === "fulfilled"
            ? crawlAttempt.value.warnings
            : [`DIRECT CRAWL FAILED: ${crawlAttempt.reason instanceof Error ? crawlAttempt.reason.message : "The submitted site was inaccessible."}`];
          const canonicalUrl = crawled?.canonicalUrl || submitted.toString();
          const sources = [...(crawled?.sources || []), ...searched.sources]
            .filter((source, index, list) => list.findIndex((item) => sourceKey(item.url) === sourceKey(source.url)) === index)
            .slice(0, 10);
          if (!sources.length) {
            if (crawlAttempt.status === "rejected" && crawlAttempt.reason instanceof Error) throw crawlAttempt.reason;
            throw new Error("No validated public evidence sources were available.");
          }

          const sitemapOnly = Boolean(crawled && crawled.evidenceMode === "sitemap" && !searched.sources.length);
          const directUnavailable = !crawled || crawled.evidenceMode === "sitemap";
          send({
            type: "stage",
            stageId: "discovery",
            status: directUnavailable ? "low_evidence" : "complete",
            message: directUnavailable
              ? `Direct page evidence was limited; ${sources.length} bounded source(s) recovered`
              : `${sources.length} bounded direct and indexed source(s) collected`,
          });
          send({
            type: "stage",
            stageId: "website",
            status: directUnavailable ? "low_evidence" : "complete",
            message: directUnavailable ? "Direct page copy limited; indexed evidence normalized" : "Untrusted page copy normalized",
          });
          send({
            type: "stage",
            stageId: "market",
            status: searched.sources.length ? "complete" : "low_evidence",
            message: searched.sources.length ? `${searched.sources.length} Tavily source(s) verified and bounded` : "No additional indexed evidence was available",
          });
          send({ type: "stage", stageId: "product", status: "running", message: "Cerebras committee is analyzing the corpus" });
          const run: InvestigationRun = InvestigationRunSchema.parse(await analyzeSources(
            canonicalUrl,
            sources,
            [...crawlWarnings, ...searched.warnings, ...(sitemapOnly ? ["Only sitemap metadata was recovered; deterministic evidence constraints apply."] : [])],
          ));
          for (const item of run.evidence) send({ type: "evidence", evidenceId: item.id, evidence: item });
          for (const agent of run.agents) {
            send({ type: "agent", agentId: agent.id, agent });
            send({ type: "stage", stageId: agent.stage, status: "complete", message: agent.summary });
          }
          for (const statement of run.committee) send({ type: "committee", statementId: statement.id, statement });
          send({ type: "stage", stageId: "memo", status: "complete", message: "Validated investment memo assembled" });
          send({ type: "complete", run });
        }
      } catch (error) {
        const message = error instanceof UrlSecurityError || error instanceof Error ? error.message : "Investigation failed safely.";
        send({ type: "error", message, recoverable: true });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
