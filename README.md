# lookup-api

Lookup orchestration, provider routing, and payment webhook service —
[Hono](https://hono.dev) on Cloudflare Workers. Edge-native on purpose: low
cold-start latency, and reachable by non-browser clients (Telegram bot,
future mobile app) without carrying the full Next.js app along (product doc
§3.1).

## What's here (Phase 0)

Just the skeleton: a `/health` check and a `/v1/*` route group behind
`internalAuth` middleware, which verifies the short-lived JWT `lookup-web`
signs per request (§3.2 option 1). `/v1/me` is a placeholder proving that
round trip works end-to-end — real lookup submission and provider-routing
endpoints are Phase 1.

## Why `nodejs_compat`

`@abeltib/lookup-core` reads secrets via plain `process.env.X` — the same
code path used by `lookup-web` on Node.js — rather than threading Workers'
`env` bindings through every function call. The `nodejs_compat` compatibility
flag (set in `wrangler.jsonc`) makes Workers populate `process.env` from
bindings for the current request, so that shared code runs unmodified here.

## Local development

```sh
cp .dev.vars.example .dev.vars   # fill in a real Neon DATABASE_URL + matching INTERNAL_JWT_SECRET
npm install
npm run dev
```

`INTERNAL_JWT_SECRET` must match the value `lookup-web` uses — see its
`.env.example`.

## Deployment

`wrangler deploy` via the `Deploy` GitHub Action on merge to `main`. Secrets
are set once with `wrangler secret put DATABASE_URL` / `wrangler secret put
INTERNAL_JWT_SECRET` — never committed to `wrangler.jsonc`.
