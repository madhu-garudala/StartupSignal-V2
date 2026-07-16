# Antigravity (AG) Code & Architecture Review — StartupSignal V2 (v1)

**Reviewer:** Google Antigravity (Gemini 3.1 Pro High · Advanced Agentic Coding)
**Date:** 2026-07-15
**Scope:** Comprehensive review of `app/`, `lib/`, `components/`, configuration, schema contracts, and existing documentation/reviews (`Claude_suggestions_v1.md`, `docs/ARCHITECTURE.md`).
**Constraint Compliance:** No code changes made (`AG_suggestions_v1.md` only). Codex will review and apply changes.

---

## Executive Summary & Alignment Check

Overall, **StartupSignal V2** is an exceptionally well-conceived, defensively structured venture intelligence application. The core architectural decision—decoupling crawling, secure retrieval, and AI inference into bounded server-only routes while streaming structured NDJSON events to an interactive React 19 / Next.js 16 command center—is robust and well-executed.

We **strongly align** with the foundational design choices:
1. **Defense-in-Depth Against Untrusted Input:** Explicit isolation of fetched web copy (`<script>/<style>` removal, byte capping, instruction hierarchy framing (`BEGIN/END UNTRUSTED SOURCE DATA`), and HTML/XML escaping).
2. **Three-Packet Schema Partitioning:** Breaking a monolithic schema into three concurrent strict-schema packets (`Intelligence`, `Decision`, `Memo`) keeps each schema within Cerebras Cloud's strict 5,000-character limit (`cerebras-schema.ts`) while allowing deterministic assembly and `Zod` validation at the boundary.
3. **Deterministic Override for Low-Signal Evidence:** Forcing `Insufficient Evidence` deterministically in code when only same-origin `sitemap.xml` catalogs are accessible, preventing model hallucination over URL path names.
4. **Strict Boundary Validation:** Rigorous `Zod` validation on all incoming request bodies, provider payloads (`Cerebras` and `Tavily`), outgoing NDJSON stream chunks, and client-side run verification.

### Status of Prior Review (`Claude_suggestions_v1.md`)
Upon auditing the current working tree against `Claude_suggestions_v1.md`, we confirm that **all 18 items identified by Claude remain open and unmitigated in the codebase**. We endorse Claude’s assessment and prioritization, and in the sections below, we **expand on those points** while identifying **12 additional critical, architectural, security, and UI/state edge cases** (`AG-1` through `AG-12`) that require Codex's attention.

---

## 1. High-Priority Issues (Security, Reliability & Schema Integrity)

### [AG-1 / Claude #1] SSRF & DNS Rebinding TOCTOU in `assertPublicDestination` + `secureFetch`
* **Locations:** `lib/security/url.ts` (`normalizePublicUrl`, `assertPublicDestination`), `lib/crawling/crawler.ts` (`secureFetch`).
* **Current Behavior:** `assertPublicDestination(url)` resolves `url.hostname` using `node:dns/promises` (`resolve4` / `resolve6`) and asserts that no returned addresses fall into private/reserved CIDR blocks (`isPrivateAddress`). Immediately afterward, `fetch(url, ...)` is invoked.
* **The Gap:** Node.js/undici's `fetch()` performs its **own independent DNS lookup** (`dns.lookup`) when opening the TCP connection. A domain configured with a short TTL (or a rebinding attack server) can return a public IP (`93.184.216.34`) during `assertPublicDestination`, and flip to a private or metadata address (`169.254.169.254`, `10.0.0.1`, `127.0.0.1`) when `fetch` connects.
* **Antigravity Extension (`AG-1.1`): Discrepancy between `resolve4/6` and `dns.lookup`:**
  `assertPublicDestination` uses `node:dns/promises.resolve4/6`, which performs direct UDP/TCP queries against name servers. However, undici `fetch` uses `dns.lookup`, which queries the OS resolver (`/etc/hosts`, `mDNS`, local split-horizon DNS). An attacker supplying a hostname defined in local hosts or internal search paths bypasses or crashes `resolve4` (`addresses.length === 0`), or causes inconsistent resolution checks.
* **Antigravity Extension (`AG-1.2`): Decimal/Octal IP & Compressed IPv6 Evasion:**
  If `input` is a decimal IP (`http://2130706433` = `127.0.0.1`) or octal IP (`http://0177.0.0.1`), `node:net.isIP(hostname)` returns `0` (not recognized as IP). `normalizePublicUrl` fails to flag `2130706433` via `isPrivateAddress(hostname)`, passing it to `assertPublicDestination`, where `resolve4("2130706433")` either resolves locally or fails depending on OS behavior. Furthermore, `isBlockedIpv6` (`lib/security/url.ts:39-54`) checks exact strings `"::"` and `"::1"`; passing `0:0:0:0:0:0:0:1` bypasses the `normalized === "::1"` check because `resolve6` may return uncompressed formats.
* **Actionable Recommendations for Codex:**
  1. **Connection Pinning:** Implement a custom `undici.Agent` / `Dispatcher` where `connect.lookup` is overridden to return **only** the vetted IP address verified during `assertPublicDestination`.
  2. **Robust CIDR / IP Parsing:** Replace manual octal/string splitting in `isBlockedIpv4`/`isBlockedIpv6` with standard `node:net` address normalizers or an audited library (e.g., `ipaddr.js`) that handles NAT64 (`64:ff9b::/96`), 6to4 (`2002::/16`), Teredo, decimal/octal encodings, and all RFC 1918 / RFC 3927 / RFC 4193 boundaries.

---

### [AG-2 / Claude #2] Timeout Budget Exceeds Route `maxDuration` (`maxDuration = 60`)
* **Locations:** `lib/ai/cerebras.ts` (`client()`, `callCerebrasStructured`), `app/api/analyze/route.ts:12`.
* **Current Behavior:** `app/api/analyze/route.ts` sets `export const maxDuration = 60;`. In `cerebras.ts:17`, the Cerebras SDK client is initialized with `timeout: 50_000` (50 seconds). When `callCerebrasStructured` runs, if primary schema validation fails, a repair request (`strict: false`, higher temperature) is launched with another 50s timeout.
* **The Gap:** Crawling and Tavily searches consume ~8–14 seconds upfront (`secureFetch` max 8s/redirect × up to 4 pages + Tavily max 14s). If `callCerebrasStructured` requires a repair attempt or stalls, total wall-clock time exceeds 60 seconds. Vercel forcefully terminates the serverless function mid-stream.
* **Antigravity Extension (`AG-2.1`): Silent Stream Death on Client:**
  When Vercel terminates the function, the HTTP chunked response closes immediately without emitting a terminal `{ type: "error" }` or `{ type: "complete" }` NDJSON event. In `components/startup-signal.tsx:53-79`, `reader.read()` returns `done: true`, exiting the loop and running `finally { setRunning(false); }`. Because `run` remains `null`, the command center displays **"HALTED"** with partial progress meters and zero explanation to the user.
* **Actionable Recommendations for Codex:**
  1. **Enforce Route-Level Deadline:** Wrap the stream execution inside an `AbortSignal.timeout(55_000)` or track elapsed time (`const deadline = Date.now() + 54_000`), emitting `{ type: "error", message: "Investigation timed out due to extensive crawling or synthesis latency.", recoverable: true }` before Vercel cuts the execution.
  2. **Lower Per-Call Timeout:** Reduce Cerebras SDK `timeout` to `22_000` ms per call so that even primary + repair completion attempts fit cleanly within the 60s envelope alongside crawling.
  3. **Client Stream Validation:** In `startup-signal.tsx`, if `reader.read()` completes (`done: true`) while `!run && !error`, explicitly set `setError("The investigation stream ended unexpectedly before completion.")`.

---

### [AG-3 / Claude #3] Missing Run Mode and Status Verification on `/api/chat` & `/api/scenario`
* **Locations:** `app/api/chat/route.ts:13`, `app/api/scenario/route.ts:12`, `lib/schemas/research-chat.ts`, `lib/schemas/investigation.ts`.
* **Current Behavior:** Both endpoints validate incoming bodies using `ResearchChatRequestSchema` / `ScenarioRequestSchema`, which enforce the structural shape of `InvestigationRunSchema`.
* **The Gap:** The schemas check structure but do not enforce `run.mode === "live"` or `run.status === "complete"`.
* **Consequences:**
  - **Quota & Spend Amplification:** An attacker can POST a payload with `mode: "demo"` or a completely fabricated `run` containing an arbitrary `run.profile.url` to `/api/chat` or `/api/scenario`. This forces the server to execute real Tavily web searches and expensive Cerebras LLM completions against arbitrary targets.
  - **Context Poisoning:** Because client-supplied `run.evidence` and `run.profile` are passed directly into the model prompts, malicious clients can inject arbitrary untrusted prompts disguised as evidence items into `Cerebras` requests.
* **Actionable Recommendations for Codex:**
  1. In `app/api/chat/route.ts`, reject requests where `body.data.run.mode !== "live" || body.data.run.status !== "complete"` with `400 Bad Request`.
  2. In `app/api/scenario/route.ts`, if `body.data.run.mode === "live"`, enforce `body.data.run.status === "complete"` before launching live synthesis.

---

### [AG-4 / Claude #4] Unfiltered Evidence IDs in Investment Memo Sections (`lib/ai/live-analysis.ts:295-308`)
* **Current Behavior:** In `finalizeAnalysis`, specialist agent reports and committee statements have their `evidenceIds` filtered against `validEvidence` (`new Set(evidenceSeeds.map(item => item.id))`).
* **The Gap:** The investment memo packet is merged without filtering section IDs:
  ```ts
  memo: { ...parsed.memo, generatedAt: now, model }
  ```
  If `parsed.memo.sections[i].evidenceIds` contains hallucinated IDs not present in `validEvidence`, those IDs pass straight into `InvestigationRun`. When `MemoView` (`components/workspace.tsx:420`) renders `[sourceMap.get(id) || "?"]`, users see `[?]` citation chips.
* **Actionable Recommendation for Codex:**
  Filter `memo.sections[].evidenceIds` consistently during final assembly:
  ```ts
  memo: {
    ...parsed.memo,
    generatedAt: now,
    model,
    sections: parsed.memo.sections.map((sec) => ({
      ...sec,
      evidenceIds: sec.evidenceIds.filter((id) => validEvidence.has(id)),
    })),
  }
  ```

---

### [AG-5] Unnecessary LLM Expenditure on Sitemap-Only / Blocked Sites (`lib/ai/live-analysis.ts:282-315`)
* **Location:** `lib/ai/live-analysis.ts` (`analyzeSources`, `finalizeAnalysis`).
* **Current Behavior:** When `crawlCompany` receives `HTTP 403` or `429` on the homepage, it falls back to `sitemap.xml` extraction (`evidenceMode: "sitemap"`). If `searchCompanyEvidence` (Tavily) returns no results (or `TAVILY_API_KEY` is absent), the final corpus contains *only* `First-party sitemap catalog` entries.
* **The Gap:** `analyzeSources` launches all three concurrent `Cerebras` structured completions (`callCerebrasStructured`), consuming ~15,000 output tokens and ~20 seconds of inference latency. Only *after* `Cerebras` finishes does `finalizeAnalysis` check:
  ```ts
  const sitemapOnly = sources.length > 0 && sources.every((source) => source.sourceType === "First-party sitemap catalog");
  parsed = sitemapOnly ? constrainSitemapOnlyAnalysis(parsed, [...validEvidence]) : parsed;
  ```
  `constrainSitemapOnlyAnalysis` deterministically discards all model-generated verdicts, agent findings, scores, probabilities, and memo sections, replacing them with fixed `Insufficient Evidence` templates!
* **Actionable Recommendation for Codex:**
  Check `sitemapOnly` inside `analyzeSources` **before** calling `callCerebrasStructured`. If all sources are sitemap catalogs, construct and return the `InvestigationRun` directly using `constrainSitemapOnlyAnalysis` templates without calling Cerebras. This saves 100% of LLM token costs and drops response time from ~20s to `<100ms` for blocked sites.

---

### [AG-6] Single Malformed NDJSON Line Aborts Entire Client Stream
* **Location:** `components/startup-signal.tsx:60`.
* **Current Behavior:** In the NDJSON stream reader loop:
  ```ts
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const parsed = InvestigationEventSchema.safeParse(JSON.parse(raw));
    ...
  }
  ```
* **The Gap:** `JSON.parse(raw)` is unprotected by a line-level `try-catch`. If network proxies, intermediate chunk boundary splits, or server flush quirks introduce even one incomplete or malformed JSON line into `lines`, `JSON.parse` throws an uncaught `SyntaxError`. The outer `catch (cause)` block catches this error and immediately terminates the entire run stream with `setError("Unexpected token...")`.
* **Actionable Recommendation for Codex:**
  Wrap line parsing inside a safe helper or per-line try-catch:
  ```ts
  try {
    const json = JSON.parse(raw);
    const parsed = InvestigationEventSchema.safeParse(json);
    if (parsed.success) { /* handle event */ }
  } catch {
    // Ignore partial or corrupted intermediary lines and continue processing subsequent stream lines
  }
  ```

---

## 2. Medium-Priority Issues (AI Orchestration, State Management & UX)

### [AG-7 / Claude #6] Scenario Stress Tests Compound Deltas Permanently Without a Baseline (`components/workspace.tsx:351-358`)
* **Current Behavior:** In `ScenarioView.execute(scenario)`, the returned `ScenarioUpdate` applies `convictionDelta` and `confidenceDelta` directly to the active `run` state:
  ```ts
  conviction: Math.max(0, Math.min(100, current.verdict.conviction + update.convictionDelta)),
  confidence: Math.max(0, Math.min(100, current.verdict.confidence + update.confidenceDelta)),
  ```
  And overwrites `probabilities.range` directly.
* **The Gap:** Each executed scenario mutates the underlying `run` permanently. Running scenario A (`-15 conviction`) followed by scenario B (`-20 conviction`) results in `-35` against the baseline. Clicking the same scenario twice applies the delta twice. There is no baseline state preserved, rendering the empty state copy (*"Baseline conviction remains X/100"*) untruthful once any scenario has run.
* **Actionable Recommendation for Codex:**
  Separate baseline `InvestigationRun` from `activeScenarios` or store `baselineRun` inside `Workspace`. Compute displayed conviction, confidence, and probability ranges dynamically as `baseline + latestScenarioDelta` (or allow an explicit reset button to clear applied counterfactuals).

---

### [AG-8 / Claude #7] `Overall risk` Score Meter Bar Never Styles Red for Live Runs (`components/workspace.tsx:301`)
* **Current Behavior:** In `VerdictView` (`components/workspace.tsx:301`), the decision matrix applies styling check:
  ```tsx
  score.id === "risk" ? "bg-[var(--red)]" : "bg-[var(--cyan)]"
  ```
* **The Gap:** In `lib/ai/live-analysis.ts:160` (`normalizeDecision`), live score dimensions are assigned sequential IDs: `score-1` through `score-8`. The 8th score (`Overall risk`) receives `id: "score-8"`. Only the deterministic demo dataset (`heliograph.ts`) assigns `id: "risk"`.
* **Consequences:** For all live investigations, the `Overall risk` bar renders cyan instead of red. Furthermore, because a high risk score indicates high danger (`85/100 risk`), rendering it identical to positive dimensions (`85/100 product`) creates visual dissonance.
* **Actionable Recommendation for Codex:**
  Normalize the ID for `Overall risk` to `"risk"` inside `normalizeDecision`:
  ```ts
  id: label === "Overall risk" ? "risk" : `score-${index + 1}`
  ```
  Or check `score.label.toLowerCase().includes("risk")` in `workspace.tsx`.

---

### [AG-9 / Claude #8] Missing Client Disconnect / Abort Signal Propagation (`app/api/analyze/route.ts`)
* **Current Behavior:** `POST /api/analyze` creates a `ReadableStream` whose `async start(controller)` method launches `crawlCompany`, `searchCompanyEvidence`, and the three `callCerebrasStructured` operations.
* **The Gap:** The route handler ignores `request.signal` and does not implement `cancel()` on `ReadableStream`. If the user closes the browser tab, clicks "Reset", or navigates away while the crawl or Cerebras completions are running, background processing continues until `maxDuration` or natural completion, wasting API credits and serverless budget.
* **Actionable Recommendation for Codex:**
  Pass `request.signal` (or an `AbortSignal.any([request.signal, routeSignal])`) down into `crawlCompany`, `searchCompanyEvidence`, and `callCerebrasStructured` (`client().chat.completions.create({ ..., signal })`). Implement `cancel()` on the `ReadableStream` to trigger controller abort immediately on client disconnect.

---

### [AG-10] Race Condition & State Interleaving on Rapid `start()` Invocations (`components/startup-signal.tsx`)
* **Current Behavior:** `start()` resets UI state (`setRun(null)`, `setStages({})`, `setRunning(true)`) and initiates `fetch("/api/analyze")`. It has no re-entrancy check (`if (running) return;`) nor cancellation of active fetch requests.
* **The Gap:** If the user rapidly double-clicks "Analyze" or switches modes while a stream is actively reading, two parallel streams will execute simultaneously. Both `reader` loops will interleave `setStages`, `setAgents`, and `setEvidence` state updates, resulting in corrupted UI state and race-condition overwrites.
* **Actionable Recommendation for Codex:**
  Keep a `useRef<AbortController | null>(null)` tracking the active stream. In `start()`, if `activeController.current` exists, call `activeController.current.abort()` before launching the new request, and check `if (signal.aborted) break;` inside the reader loop.

---

### [AG-11] Progress Meter Stalls at 20% During Entire AI Synthesis Phase (`components/workspace.tsx:56-57`)
* **Current Behavior:** Progress percentage is computed as:
  ```tsx
  const completed = Object.values(props.stages).filter((stage) => stage.status === "complete" || stage.status === "low_evidence").length;
  const progress = props.run ? 100 : Math.round((completed / pipelineStages.length) * 100);
  ```
* **The Gap:** There are 15 stages defined in `pipelineStages`. Before `analyzeSources` completes, only `discovery`, `website`, and `market` stages have emitted completion status (`3 / 15 = 20%`). During the 15–30 seconds when `Cerebras` is synthesizing the 3 concurrent packets, the progress meter sits frozen at `20%`. When synthesis completes, all 12 remaining agent/committee stages are emitted in a 50ms burst, jumping instantly from `20%` to `100%`.
* **Actionable Recommendation for Codex:**
  Before awaiting `Promise.all` in `analyzeSources`, emit intermediate `{ type: "stage", stageId: "product", status: "running", message: "Specialist committee analyzing corpus..." }` events for key analytical stages, or implement a smooth synthetic client-side ticker between `20%` and `85%` while `running && !run`.

---

### [AG-12 / Claude #9] Prompt Demands Fields That Server Code Unconditionally Overwrites (`lib/ai/live-analysis.ts`)
* **Current Behavior:** `IntelligencePacketSchema` demands `ModelCompanyProfileSchema` (`url`, `faviconUrl`), and `MemoPacketSchema` demands `InvestmentMemoSchema` (`generatedAt`, `model`). The prompt instructions explicitly command Cerebras: *“The analyzedAt and memo generatedAt values must be ${now}. Use ${canonicalUrl} as the profile URL... Use ${model} as the model field.”*
* **The Gap:** In `finalizeAnalysis`, the server unconditionally overwrites these generated fields:
  ```ts
  profile: { ...parsed.profile, url: canonicalUrl, domain: url.hostname, analyzedAt: now, faviconUrl: null },
  memo: { ...parsed.memo, generatedAt: now, model }
  ```
* **Consequences:** Demanding these fields consumes Cerebras strict schema character budget (`< 5,000` limit), wastes output tokens, and introduces unnecessary schema validation failure surface.
* **Actionable Recommendation for Codex:**
  Use reduced provider schemas (`ProviderProfileSchema` and `ProviderMemoSchema`) that omit server-owned fields (`url`, `domain`, `faviconUrl`, `analyzedAt`, `generatedAt`, `model`), injecting them only during `normalizeIntelligence` / `finalizeAnalysis`.

---

## 3. Low-Priority / Hardening Opportunities

### [AG-13 / Claude #5] Cerebras Repair Attempt Loses Error Context and Validation Path (`lib/ai/cerebras.ts:70-81`)
* **Current Behavior:** When `callCerebrasStructured` fails `validator.safeParse` on the first attempt, it initiates a retry with `strict: false` and `temperature: 0.35`, appending `Return only compact JSON matching the schema...` to the system prompt.
* **The Gap:** The repair call does **not** inform the model what validation error occurred (`parsed.error.issues`), nor does it provide the malformed string `raw` for self-correction. Running the exact same user prompt from scratch at higher temperature (`0.35`) without strict enforcement actually increases output randomness and probability of repeated schema drift.
* **Actionable Recommendation for Codex:**
  On repair retry, include the malformed output and exact Zod path error inside the user prompt:
  ```ts
  content: `Your previous output failed validation at path "${parsed.error.issues[0]?.path.join(".") || "root"}": ${parsed.error.issues[0]?.message}.\nMalformed output excerpt: ${raw.slice(0, 800)}\n\nCorrect the JSON and return valid schema structure.`
  ```

---

### [AG-14 / Claude #10] Rate Limiting Keyed on Client-Controllable Header (`lib/security/rate-limit.ts`)
* **Current Behavior:** All routes extract client IP via `request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local"`.
* **The Gap:** While Vercel properly overwrites `x-forwarded-for` at the edge, self-hosted or standard proxy deployments without edge header stripping allow clients to forge `x-forwarded-for`, bypassing rate limits entirely. Furthermore, unique forged IPs can flood the in-memory `windows` `Map`, as cleanup only runs when `windows.size > 1_000`.
* **Actionable Recommendation for Codex:**
  Use platform-verified IP headers (`x-real-ip` or `request.headers.get("x-vercel-forwarded-for")`) when available, and implement LRU eviction on `windows` to prevent memory exhaustion under spoofed-IP floods.

---

### [AG-15 / Claude #11 & #12] Crawler Hardening (`robots.txt` & Character Encoding)
* **`robots.txt` (`lib/crawling/crawler.ts:83-94`):** `parseRobots` uses basic prefix matching (`url.pathname.startsWith(path)`). It does not support `Allow` directives, wildcards (`*`), or end anchors (`$`), meaning `Disallow: /*?` is treated as a literal prefix rather than query-string exclusion.
* **Character Encoding (`lib/crawling/crawler.ts:24`):** `readBoundedBody` hardcodes `new TextDecoder()` (UTF-8). Pages served in `ISO-8859-1`, `Windows-1252`, or `Shift_JIS` will produce mojibake inside `source.excerpt` and confuse model synthesis. Extract character encoding from the `content-type` header or `<meta charset>` tag when available.

---

### [AG-16 / Claude #14 & #17] Citation Sanitizer Strips Multi-ID Brackets & Unverified Tavily Params
* **Citation Sanitizer (`lib/ai/research-chat-citations.ts:2`):** `sanitizeInlineCitations` matches `\[([^\]]{1,120})\]` against `validIds.has(id)`. If the model emits multi-ID brackets like `[ev-live-1, ev-live-2]` or legitimate prose `[Note: ...]`, the entire bracketed block is stripped. Split comma-delimited strings inside brackets before checking `validIds`.
* **Tavily Parameters (`lib/search/tavily.ts:125`):** `exact_match: true` and `safe_search: true` are passed inside `searchCompanyEvidence`. Verify against official Tavily API documentation whether these non-standard keys are ignored silently or impact ranking behavior.

---

### [AG-17] Redundant `safeCorpus` Network Payloads Across Concurrent Cerebras Requests
* **Current Behavior:** `analyzeSources` constructs `sharedInput` (`JSON.stringify(corpus)`) containing up to ~40,000 characters (~12,000 tokens) of untrusted text. This identical 40KB payload is transmitted across the network three times concurrently (`intelligence`, `decision`, and `memo` calls).
* **Actionable Recommendation for Codex:**
  If Cerebras supports prompt caching (`prompt_cache_id` or prefix caching), ensure the shared system + corpus prefix is identically structured so the second and third concurrent calls hit edge KV cache rather than re-evaluating 12,000 tokens of input.

---

## 4. Consolidated Action Checklist for Codex

| ID | Priority | Module | Summary |
|---|---|---|---|
| **AG-1** | High | `url.ts` / `crawler.ts` | Fix DNS rebinding TOCTOU; pin connection `lookup` to checked public IP. |
| **AG-2** | High | `cerebras.ts` / `analyze` | Align timeouts with 60s `maxDuration`; emit terminal error on deadline; fix client silent death. |
| **AG-3** | High | `chat` / `scenario` routes | Enforce `mode === "live" && status === "complete"` in request schema validation. |
| **AG-4** | High | `live-analysis.ts` | Filter `memo.sections[].evidenceIds` against `validEvidence` to prevent `[?]` chips. |
| **AG-5** | High | `live-analysis.ts` | Short-circuit `analyzeSources` for sitemap-only corpora before calling Cerebras. |
| **AG-6** | High | `startup-signal.tsx` | Add line-level `try-catch` around `JSON.parse(raw)` in NDJSON stream reader. |
| **AG-7** | Medium | `workspace.tsx` | Separate baseline run from counterfactual deltas so scenarios don't permanently compound. |
| **AG-8** | Medium | `workspace.tsx` / `live-analysis` | Fix `Overall risk` score ID so the risk progress meter renders red on live runs. |
| **AG-9** | Medium | `analyze/route.ts` | Propagate `request.signal` down to `fetch` and Cerebras SDK; wire `cancel()` on `ReadableStream`. |
| **AG-10** | Medium | `startup-signal.tsx` | Abort active fetch stream before initiating a new `start()` run to prevent state interleaving. |
| **AG-11** | Medium | `analyze/route.ts` / `workspace` | Emit intermediate progress events during AI synthesis to eliminate frozen 20% progress bar. |
| **AG-12** | Medium | `live-analysis.ts` / `schemas` | Remove server-overwritten fields (`url`, `analyzedAt`, `generatedAt`, `model`) from Cerebras schemas. |
| **AG-13** | Low | `cerebras.ts` | Inject validation error details and malformed JSON excerpt into Cerebras repair prompt. |
| **AG-14** | Low | `rate-limit.ts` | Document proxy header expectations (`x-real-ip`); add LRU cleanup for forged IP protection. |
| **AG-15** | Low | `crawler.ts` | Add `Allow`/wildcard support to `robots.txt` parser; respect `charset` in `readBoundedBody`. |
| **AG-16** | Low | `research-chat-citations.ts` | Split comma-delimited multi-citation brackets (`[ev-1, ev-2]`) before filtering. |
| **AG-17** | Low | `live-analysis.ts` | Optimize concurrent prompt payloads for Cerebras prefix cache efficiency. |
