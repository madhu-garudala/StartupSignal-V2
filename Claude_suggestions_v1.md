# Claude Review — StartupSignal V2 (v1)

Reviewer: Claude (Fable 5) · Date: 2026-07-15
Scope: full read of `app/`, `lib/`, `components/`, config, and docs. No code changes made.
Verification at review time: `npm run lint` clean, `npm run typecheck` clean, `npm test` 46/46 passing.

## Overall assessment

This is a well-engineered codebase and I align with most of its design decisions. Standout strengths:

- **Defense-in-depth around untrusted input.** URL normalization, DNS checks, manual redirect revalidation, byte caps, content-type allowlists, inert HTML extraction, and explicit "untrusted data, never instruction" framing in every prompt. This is far above typical hackathon/demo quality.
- **Zod at every boundary.** Requests, provider responses (Cerebras *and* Tavily), NDJSON events, and even client-side re-validation of the completed run. The three-packet split to stay under Cerebras's 5,000-char schema limit, with the original Zod schema staying authoritative, is a clean pattern.
- **Deterministic guardrails over model judgment.** The sitemap-only constraint that forces `Insufficient Evidence` server-side (not via prompt) is exactly the right instinct.
- **Honest docs.** README limitations match the code almost everywhere (exceptions noted below).

The issues below are ordered by severity. Nothing is a blocker for a demo deployment; items 1–3 matter before broader public exposure.

---

## High priority

### 1. DNS rebinding TOCTOU in the SSRF guard
`lib/security/url.ts` (`assertPublicDestination`) + `lib/crawling/crawler.ts:53-57` (`secureFetch`).

The guard resolves DNS and checks the addresses, then calls `fetch(url, ...)` — which performs its **own, independent DNS resolution**. A hostname with a short TTL can return a public IP to the check and a private IP (169.254.169.254, 10.x, etc.) to the actual connection. The redirect loop re-asserts per hop, but every hop has the same gap.

**Suggested fix:** pin the connection to the vetted IP. With undici (Node's fetch), supply a custom `Agent`/dispatcher whose `connect.lookup` returns only the addresses that passed `isPrivateAddress`, or connect by IP with `Host`/SNI set to the hostname. Alternatively route all first-party fetching through Tavily Extract (which already runs off-box) and drop direct crawling. The README currently implies this class of attack is handled ("resolves DNS, blocks private ... destinations"), so either fix it or scope the claim.

### 2. Timeout budget can exceed `maxDuration` and kill the stream silently
`lib/ai/cerebras.ts:17` sets the client timeout to **50s**, and `callCerebrasStructured` makes up to **two sequential calls** (initial + repair) → worst case ~100s for a single packet. The analyze route runs after crawling (up to ~5 sequential fetches × 8s) and declares `maxDuration = 60`.

If the function is killed mid-stream, the client's reader just ends — no `error` event is emitted, `running` flips to false, and the UI shows "HALTED" with a partially filled pipeline and no explanation.

**Suggested fixes (any subset):**
- Budget explicitly: derive per-call timeouts from remaining wall-clock (e.g., 20s primary + 15s repair), or lower the Cerebras client timeout to ~22s.
- Emit a terminal `error` event from a route-level deadline (e.g., `AbortSignal.timeout(55_000)`) so the client always gets a typed ending.
- Client-side: treat stream end without a `complete`/`error` event as a failure and surface a message.

### 3. Chat/scenario accept any schema-valid client-supplied run
`app/api/chat/route.ts`, `app/api/scenario/route.ts`, `lib/schemas/research-chat.ts`.

Docs say the chat route "accepts only a validated **completed** run", but `ResearchChatRequestSchema`/`ScenarioRequestSchema` only check shape — not `mode === "live"`, not `status === "complete"`. Consequences:

- A direct API caller can submit a `mode: "demo"` or fully **fabricated** run and drive real Tavily searches + Cerebras completions against arbitrary `run.profile.url` content (spend amplification; rate limit is the only backstop, and it's per-instance).
- Fabricated "evidence" excerpts become model context. They're framed as untrusted, but this is a free prompt-injection channel into your own provider quota.

**Suggested fix:** in both routes, reject `run.mode !== "live"` and `run.status !== "complete"` for the live paths (scenario already branches on demo; chat doesn't check at all). The durable fix — acknowledged in the README — is server-side run persistence with the client sending a run ID; worth prioritizing since it also shrinks the very large request bodies (the entire run is re-uploaded on every chat turn and scenario).

---

## Medium priority

### 4. Memo section evidence IDs are not filtered
`lib/ai/live-analysis.ts` (`finalizeAnalysis`): agents' claims and committee statements have `evidenceIds` filtered against the valid set, but `memo.sections[].evidenceIds` pass through unfiltered. Hallucinated IDs reach the UI, where `MemoView` renders them as `[?]` chips (`components/workspace.tsx:420`). One extra `.map` in `finalizeAnalysis` fixes it and makes the sanitization story consistent.

### 5. One malformed NDJSON line aborts the whole client stream
`components/startup-signal.tsx:60`: `InvestigationEventSchema.safeParse(JSON.parse(raw))` — the `JSON.parse` is outside any per-line guard, so a single corrupt line (proxy buffering artifacts, a truncated final flush) throws, exits the read loop through the outer catch, and the run dies even if the server would have delivered `complete`. Wrap the parse per line (or use a small `safeJson` helper) and `continue` on failure.

### 6. Scenario deltas compound with no baseline
`components/workspace.tsx:351-357` (`ScenarioView.execute`): each scenario applies `convictionDelta`/`confidenceDelta` on top of the **already-mutated** verdict, and overwrites probability ranges permanently. Re-running the same scenario twice shifts conviction twice (the `scenarios` list dedupes by ID, but the applied deltas don't). There's no way back to the baseline verdict.

**Suggested fix:** keep the original run immutable and derive the displayed verdict as `baseline + latest scenario` (or an explicit stack with a reset button). This also makes "Baseline conviction remains X/100" in the empty state truthful after the first scenario.

### 7. The "Overall risk" red bar never triggers on live runs
`components/workspace.tsx:301` styles the decision-matrix bar red when `score.id === "risk"`, but live IDs are assigned as `score-1…score-8` by `normalizeDecision` (`lib/ai/live-analysis.ts:158-164`); only the demo dataset uses `id: "risk"`. Match on the label or normalize the live ID to `risk`. Note the semantic footgun the prompt itself flags: risk scores high = bad, all other scores high = good, and the UI renders them identically for live runs.

### 8. No client-disconnect propagation in the analyze route
`app/api/analyze/route.ts` ignores `request.signal` and doesn't implement the stream's `cancel()`. If the user navigates away mid-run, the crawl, both Tavily calls, and all three Cerebras completions run to completion — pure wasted spend. Thread an `AbortSignal` from the request through `crawlCompany`, `searchCompanyEvidence`, and the Cerebras client calls.

### 9. Model is asked to generate fields the server overwrites
`ModelCompanyProfileSchema` requires `url` and `faviconUrl`; `InvestmentMemoSchema` requires `generatedAt` and `model` — and the prompt even instructs specific values for them — yet `finalizeAnalysis` unconditionally overwrites all four. That's wasted schema budget (the 5,000-char limit is tight), wasted completion tokens, and extra validation-failure surface. Use reduced provider schemas that omit server-owned fields and inject them during assembly.

---

## Low priority / hardening notes

### 10. Rate limiting keyed on client-influencable header
All three routes key on the **first** entry of `x-forwarded-for`. On Vercel this header is overwritten by the platform, so it's fine there — but self-hosted behind a default nginx/other proxy, the leftmost entry is client-supplied, making the limiter trivially bypassable (and letting an attacker grow the `windows` map with unique keys; cleanup only triggers past 1,000 entries and only removes expired ones). Consider a platform-specific header (`x-real-ip`) with a documented deployment assumption. The per-instance limitation itself is already honestly documented.

### 11. robots.txt parser is simplistic in over-permissive directions
`lib/crawling/crawler.ts` (`parseRobots`): group semantics are approximate (a later `User-agent` line inside the same group toggles `applies`), and there's no support for `Allow`, wildcards (`*`), or `$` anchors — `Disallow: /*?` is treated as the literal prefix `/*?`, which never matches, i.e., the crawler may crawl paths the site intended to disallow. Also worth noting: when robots disallows the homepage, `crawlCompany` throws but the route still proceeds with a Tavily-only analysis — defensible (Tavily's crawler honors robots on its own end), but the README's "honors a conservative robots policy" reads stronger than that.

### 12. Charset handling in `readBoundedBody`
The `TextDecoder` is hardcoded UTF-8; pages declaring `charset=iso-8859-1`/`windows-1252`/`shift_jis` will produce mojibake that flows into the model corpus. Reading the charset from `Content-Type` (or accepting the limitation with a warning) would be cleaner.

### 13. `sourceKey("")` collision for invalid URLs
`lib/search/tavily-contract.ts:38-49` returns `""` for unparseable URLs, so all invalid URLs dedupe to a single survivor in the various `findIndex` dedup filters. Low impact because URLs are validated upstream in most paths, but returning the raw input on failure would be safer.

### 14. Citation sanitizer strips more than invalid IDs
`sanitizeInlineCitations` removes **any** bracketed text (≤120 chars) that isn't exactly a valid ID — including legitimate prose brackets and multi-ID citations like `[ev-live-1, ev-live-2]`, which lose their citation value entirely. Consider splitting on `,`/whitespace inside brackets and keeping the valid subset.

### 15. IPv6 blocklist edge prefixes
`isBlockedIpv6` misses NAT64 (`64:ff9b::/96`), 6to4 (`2002::/16`), and Teredo (`2001::/32` beyond `2001:db8`), all of which can embed private IPv4 addresses. Item 1 (connection pinning) largely subsumes this; otherwise add the three prefixes.

### 16. No security response headers
`next.config.ts` sets `poweredByHeader: false` but nothing else. For an app rendering model output and third-party excerpts, add `Content-Security-Policy`, `X-Frame-Options`/`frame-ancestors`, `Referrer-Policy`, and `Permissions-Policy` via `headers()`. React escaping covers XSS in the current rendering paths (I found no `dangerouslySetInnerHTML`), so this is belt-and-braces.

### 17. Unverified Tavily parameters
`exact_match` and `safe_search` (`lib/search/tavily.ts`) don't appear in the Tavily API docs I'm aware of; unknown params are likely ignored silently, meaning the independent search may not behave as intended. Worth verifying against current Tavily docs.

### 18. Minor UI nits
- Progress meter stalls (~20%) for the entire synthesis phase, the longest wait — consider a synthetic ticker or per-packet progress events.
- `Landing`: Enter/Analyze with an empty field shows the error only after switching intent; disabling the button on empty input is cheaper feedback.
- `startup-signal.tsx` `start()` has no re-entrancy guard (`if (running) return;`); rapid double-invocation launches two streams writing to the same state.

---

## Things I explicitly agree with (no change requested)

- Splitting the investigation into three concurrent packets with deterministic reassembly, rather than fighting one giant schema.
- The one-repair-attempt policy with `strict: false` + higher temperature on retry, with Zod as the final arbiter.
- Forcing `Insufficient Evidence` deterministically in code for sitemap-only corpora instead of trusting the prompt.
- Escaping `<`/`>` in corpus text, `BEGIN/END UNTRUSTED SOURCE DATA` fencing, and the instruction-hierarchy framing.
- Keeping keys in lazily-read server-only modules with `import "server-only"`.
- The NDJSON event protocol with a discriminated union schema shared by both sides.
- Demo mode as a keyless, explicitly fictional path through the exact same run contract.

## Suggested priority for Codex

1. Fix #1 (DNS pinning) and #2 (timeout budget + terminal error event) — these affect security and perceived reliability of every live run.
2. Fix #3 (run gating) and #4 (memo ID filtering) — small diffs, close real gaps between docs and code.
3. Fix #5–#8 as a UX/robustness batch.
4. Treat #9–#18 as opportunistic cleanups.
