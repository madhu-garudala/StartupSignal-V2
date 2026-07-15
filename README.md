# StartupSignal V2

StartupSignal turns a startup URL into an evidence-backed venture investigation, specialist-agent findings, a committee verdict, scenario stress tests, and a living investment memo. V2 preserves the original product experience while moving live synthesis to Cerebras for lower-latency model inference.

The application has two paths:

- **Demo:** a deterministic, explicitly fictional Heliograph investigation with no API key or network dependency.
- **Live:** an SSRF-protected bounded crawl enriched with Tavily first-party and independent search, followed by concurrent, Zod-validated Cerebras synthesis.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the system and trust-boundary diagrams.

## Stack

- Next.js 16 App Router, React 19, and strict TypeScript
- Tailwind CSS 4 and Motion
- Official Cerebras Cloud SDK using Chat Completions and strict JSON Schema output
- Tavily Search and Extract through bounded, server-only REST calls
- Zod schemas for model packets, requests, events, investigations, and scenarios
- Cheerio for inert HTML text extraction
- Vitest for crawler, security, schema, and Cerebras contract coverage

## Local setup

Requirements: Node.js 20.9 or newer and npm.

```bash
cd /Users/madhugarudala/Desktop/Code/Codex/StartupSignal-V2
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The existing `.env.local` supplies live mode; demo mode works without it.

Environment variables:

```bash
CEREBRAS_API_KEY=your_cerebras_api_key
TAVILY_API_KEY=your_tavily_api_key
CEREBRAS_MODEL=gemma-4-31b
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

`CEREBRAS_API_KEY` is required for live synthesis. `TAVILY_API_KEY` is recommended for indexed first-party and independent evidence; without it, the app falls back to direct crawling and sitemap metadata. `CEREBRAS_MODEL` overrides the default. `NEXT_PUBLIC_APP_URL` is optional because Vercel's system URL is detected automatically. API keys are read only by server route code and are never sent to the browser.

## Verification

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Deploy to Vercel

### Dashboard

1. Push this V2 repository to GitHub, GitLab, or Bitbucket.
2. In Vercel, select **Add New > Project** and import the V2 repository.
3. Keep **Next.js** as the framework preset and `npm run build` as the build command.
4. Add `CEREBRAS_API_KEY` and `TAVILY_API_KEY` for Production and Preview.
5. Optionally add `CEREBRAS_MODEL=gemma-4-31b` to make the selected model explicit.
6. Select **Deploy**. No `NEXT_PUBLIC_APP_URL` value is required for a standard Vercel deployment.

### CLI

```bash
npm install -g vercel
vercel login
cd /Users/madhugarudala/Desktop/Code/Codex/StartupSignal-V2
vercel
vercel env add CEREBRAS_API_KEY production
vercel env add TAVILY_API_KEY production
vercel env add CEREBRAS_MODEL production
vercel --prod
```

Run the environment commands with `preview` if live analysis is needed on preview deployments.

## Security and reliability

The crawler accepts only HTTP/S, removes credentials and fragments, limits ports, resolves DNS, blocks private, reserved, link-local, and metadata destinations, revalidates redirects, honors a conservative robots policy, and caps redirects, time, pages, and retained response bytes. It accepts only text content and removes scripts, styles, frames, SVG, and forms before model input. Pages larger than 500 KB are truncated at the byte boundary and coverage warnings remain attached to the investigation.

Fetched content is untrusted data, never model instruction. Cerebras receives explicit instruction hierarchy and only the bounded corpus. Three strict JSON Schema packets run concurrently, each stays under Cerebras's 5,000-character schema limit, and all are revalidated with Zod before the UI sees a result. A single bounded repair attempt handles malformed provider output.

Tavily runs two deterministic searches: one restricted to the submitted domain and one for independent evidence with social/UGC domains excluded. Returned URLs are normalized, checked for public DNS destinations, deduplicated, capped at six, and optionally extracted into query-focused chunks. Search and extraction responses are Zod-validated and remain explicitly untrusted.

When a homepage returns HTTP 403 or 429, publicly accessible same-origin XML sitemaps remain a metadata fallback while Tavily attempts to recover substantive first-party and independent evidence. If Tavily also returns no evidence, the sitemap-only safety constraint forces `Insufficient Evidence` with low confidence.

## Current limitations

- Live work runs inside one request with `maxDuration = 60`; durable queues and run storage are required for broader production research.
- Crawling is limited to four same-origin pages. Sites may block automation, prohibit crawling, require client rendering, or time out.
- Search quality depends on Tavily's index and source ranking. StartupSignal preserves source URLs, provenance, reliability, and uncertainty rather than treating retrieval as verification.
- Rate limiting is in-memory and best-effort per warm function instance. Use a distributed limiter before broad public exposure.
- Runs are not persisted across devices or refreshes, and the product does not claim predictive or fiduciary authority.
