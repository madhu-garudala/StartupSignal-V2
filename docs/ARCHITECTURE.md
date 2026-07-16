# StartupSignal V2 Architecture

StartupSignal V2 is a Next.js App Router application that turns a company name or website into a typed investment investigation. Plain names are resolved to a high-confidence official website through bounded Tavily search; direct domains and URLs skip that step. The browser renders a progressive command-center workspace. Crawling, URL security, provider access, and secrets remain in Node.js server routes. Demo and live paths converge on the same `InvestigationRun` schema.

## System

```mermaid
flowchart LR
  browser[Browser workspace] -->|NDJSON investigation request| analyze[POST /api/analyze]
  browser -->|counterfactual + validated run| scenario[POST /api/scenario]
  browser -->|question + active run + bounded history| chat[POST /api/chat]

  analyze --> demo[Deterministic demo dataset]
  analyze --> guard[URL normalization + SSRF guard]
  guard --> crawler[Robots-aware bounded crawler]
  guard --> tavily[Tavily first-party + independent search]
  crawler --> corpus[Normalized untrusted corpus]
  crawler -.->|homepage 403 or 429| sitemap[Same-origin sitemap catalog fallback]
  sitemap --> corpus
  tavily --> verify[Public URL validation + bounded extraction]
  verify --> corpus
  corpus --> intelligence[Intelligence packet]
  corpus --> decision[Decision packet]
  corpus --> memo[Memo packet]

  intelligence --> cerebras[Cerebras Chat Completions]
  decision --> cerebras
  memo --> cerebras
  scenario --> cerebras
  chat --> chatsearch[Question-specific Tavily search]
  chatsearch --> chat
  chat --> cerebras

  cerebras --> zod[Zod validation]
  zod --> run[InvestigationRun]
  demo --> run
  run --> browser
```

The analysis route opens an NDJSON stream immediately. Demo mode emits deterministic staged events. Live mode runs the secure crawler and Tavily retrieval concurrently after the submitted destination passes public-network validation. It then launches three Cerebras structured-output calls concurrently, validates every packet, assembles the common run contract, and emits evidence, agents, committee statements, and the final verdict. The chat route accepts only a validated completed run, a 500-character question, and eight bounded conversation turns.

## Provider Boundary

```mermaid
flowchart TD
  source[Up to four direct pages + six indexed sources] --> prompt[Shared evidence-first prompt]
  prompt --> p1[Profile + 13 specialists]
  prompt --> p2[Committee + verdict + scores + scenarios]
  prompt --> p3[Investment memo + warnings]
  p1 --> strict[Strict JSON Schema decoding]
  p2 --> strict
  p3 --> strict
  strict --> validate[Independent Zod validation]
  validate --> assemble[Deterministic assembly]
  assemble --> sanitize[Evidence-ID filtering + timestamps]
  sanitize --> output[InvestigationRun]
```

The complete investigation schema exceeds Cerebras's 5,000-character strict-schema limit. V2 partitions it into three smaller schemas and executes them concurrently. Unsupported JSON Schema constraints are removed from the provider schema, every object is closed with `additionalProperties: false`, and the original Zod constraints remain authoritative after generation. The intelligence packet includes an evidence-cited valuation snapshot with an explicit unknown state. One clean repair attempt is allowed per packet.

## Trust Boundary

```mermaid
flowchart LR
  input[Submitted name or URL] --> resolve[Resolve names to likely official site]
  resolve --> normalize[Normalize scheme, host, port, credentials]
  normalize --> dns[Resolve all addresses]
  dns --> deny{Public destination?}
  deny -->|No| reject[Reject request]
  deny -->|Yes| pin[Pin connection to validated IP]
  pin --> fetch[Manual redirect fetch]
  deny -->|Yes| search[Fixed Tavily API endpoint]
  fetch --> dns
  fetch --> bytes[500 KB retained-byte cap]
  bytes --> extract[Remove active HTML and normalize text]
  extract --> envelope[Mark content as untrusted data]
  search --> resultcheck[Validate response schema, URL, DNS, domain scope, and byte limits]
  resultcheck --> envelope
  envelope --> model[Cerebras structured synthesis]
  model --> validate[Zod validate and filter evidence IDs]
  validate --> client[Stream typed events]
```

The provider keys are read lazily from `CEREBRAS_API_KEY` and `TAVILY_API_KEY` inside server-only modules. They are never exposed through `NEXT_PUBLIC_` variables. Direct page crawling remains the primary first-party connector. Every direct connection uses an Undici dispatcher pinned to the public DNS result that passed SSRF validation, including redirects. Tavily adds at most three domain-restricted and three independent sources; social and UGC domains are excluded from the independent query. For HTTP 403/429 homepages, a bounded sitemap fallback may add URL catalogs while Tavily attempts substantive retrieval. If no substantive sources are recovered, the route assembles `Insufficient Evidence` deterministically without model spend.

## Serverless Constraints

| Area | Current design | Production extension |
| --- | --- | --- |
| Execution | One bounded request, `maxDuration = 60`, 55-second abort deadline | Durable queue and resumable run state |
| Persistence | Client memory | Database-backed investigations and memo versions |
| Rate limits | Per-instance memory | Distributed Vercel KV or equivalent |
| Evidence | Four direct pages or sitemap catalogs, plus six Tavily sources | Audited paid datasets, repositories, and data-room connectors |
| Demo | Keyless fictional dataset | Keep as deterministic incident and sales fallback |

The scenario endpoint accepts a validated completed run and a bounded counterfactual. Demo scenarios are deterministic. Live scenarios use the same Cerebras strict-output helper without gathering or inventing new evidence.

The research channel binds every question to `run.profile`, so pronouns resolve to the active company. Tavily performs domain-restricted and independent question searches, filters social sources, validates public destinations, and extracts at most four sources. Cerebras returns a strict `ResearchChatAnswer`; the server filters evidence IDs and removes unsupported inline citations before returning the answer and source metadata to the widget. Forecast questions require a probability range, horizon, basis, assumptions, and uncertainty.
