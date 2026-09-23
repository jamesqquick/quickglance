# QuickGlance

See your landing page through a first-time visitor's eyes. Paste a URL, describe what visitors should walk away knowing, and get an honest AI-generated read on whether the page actually delivers that message.

Built on Cloudflare Workers using Browser Run, Workers AI, and KV.

## How it works

1. Worker uses the Browser Run `snapshot` Quick Action to capture a JPEG screenshot and rendered Markdown in one request.
2. Sends the page Markdown, screenshot, and user's intended takeaway to Workers AI (`@cf/google/gemma-4-26b-a4b-it`) for a vision-enabled structured comparison.
3. Stores the result in KV (7-day TTL) and serves it via a shareable `/results/:id` URL.

## Stack

- Cloudflare Workers (TypeScript)
- Browser Run Quick Actions
- Workers AI
- Workers KV (cache)
- Workers Assets (static HTML/CSS/JS)

## Prerequisites

- A Cloudflare account with Workers, Browser Run, Workers AI, and KV access
- Node.js 22+
- `wrangler` CLI (installed via `npm install`)

## Setup

```bash
git clone <this-repo>
cd quickglance
npm install
```

Create your own KV namespace and update `wrangler.jsonc` with the new ID:

```bash
npx wrangler kv namespace create JQQ_BROWSER_RUN_ANALYSES
```

Replace the `id` field in `wrangler.jsonc` under `kv_namespaces` with the value returned above.

## Run locally

Browser Run and Workers AI require a remote connection — there is no local emulation:

```bash
npm run dev
```

This runs `wrangler dev --remote`.

## Deploy

```bash
npm run deploy
```

## Project structure

```
src/index.ts        # Worker entrypoint (API + routing)
public/index.html   # Submission form
public/results.html # Results page
wrangler.jsonc      # Worker config + bindings
```

## API

- `POST /api/analyze` — body: `{ url, expectedTakeaway, refresh? }`. Returns the analysis (cached or fresh).
- `GET /api/results/:id` — fetch a previously generated analysis by ID.

## Notes & caveats

This is a demo project. Things to be aware of before running it in production:

- **Basic rate limiting only.** The demo allows 10 analyses per IP per minute through a Workers Rate Limit binding; revisit the policy before exposing it at scale.
- **Basic SSRF guard only.** The URL validator blocks common private IP ranges (`localhost`, RFC1918, link-local, `.internal`, `.local`), but does not protect against DNS rebinding or full IPv6 private-range coverage. Cloudflare's network already isolates Workers from internal infrastructure, but if you fork this for a different runtime, harden the check.
- **Screenshots are stored in KV as base64 data URLs.** This works for a demo but R2 is a better fit for binary blobs at any real volume.
- **Page Markdown is truncated to 6000 characters** before being sent to the model alongside the screenshot.
- **Cached results expire after 7 days.**
