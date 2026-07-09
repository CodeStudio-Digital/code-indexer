---
name: cloudflare-app
description: Recipes for App Studio cf-fullstack workspaces — wrangler.jsonc rules, D1 migrations and query patterns, better-auth over D1 wiring, SPA assets routing and deploy troubleshooting. Load before worker/database/auth work in an App Studio project.
context-mode: auto
trigger:
  paths:
    - "**/wrangler.jsonc"
    - "**/worker/**"
    - "**/migrations/*.sql"
  tags:
    - app-studio
    - cloudflare
source: builtin
version: 1.0.0
sort-order: 66
---

# Cloudflare app recipes (App Studio `cf-fullstack` template)

Curated from Cloudflare's official guidance, adapted to THIS template: Vite React SPA + Hono Worker + D1, dev served by `@cloudflare/vite-plugin` (SPA + workerd on ONE port), deployed with `wrangler deploy` to the user's account.

## wrangler.jsonc — managed contract
- NEVER change `name`, `main`, `assets`, or `d1_databases[0].database_id` (the publish flow writes the real id over `APP-STUDIO-PLACEHOLDER`).
- You MAY add `vars`, extra bindings (KV/R2/queues) and `compatibility_flags`. Keep JSONC comments intact.
- `assets.run_worker_first: ["/api/*"]` means the Worker only ever sees `/api/*` — everything else is static/SPA. Never write worker routes outside `/api`.
- Secrets: local dev reads `.dev.vars` (gitignored); production uses `wrangler secret put NAME` (the launch flow handles prod secrets — you only maintain `.dev.vars`).

## D1 — schema and queries
- Schema changes ONLY via a NEW file in `migrations/` (`0002_add_x.sql`, ordered by name). Never edit an applied migration; never create tables at runtime.
- After changing migrations run `app_provision_db` (applies locally to the same state the preview reads: `.wrangler/state`).
- Queries ALWAYS use placeholders: `c.env.DB.prepare('SELECT * FROM pedidos WHERE id = ?').bind(id).all()`. String interpolation inside `prepare()` fails the security audit.
- Batch inserts: `c.env.DB.batch([stmt1, stmt2])`. Pagination: `LIMIT ? OFFSET ?` with bound values.
- D1 is SQLite: types are TEXT/INTEGER/REAL/BLOB; store timestamps as ISO-8601 TEXT (`datetime('now')` default works).

## Hono API patterns
```ts
// worker/api.ts — one sub-router per entity keeps files small
api.get('/pedidos', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM pedidos ORDER BY id DESC LIMIT 50').all();
  return c.json(results);
});
api.post('/pedidos', async (c) => {
  const body = await c.req.json<{ cliente: string }>();
  if (!body.cliente?.trim()) return c.json({ error: 'cliente is required' }, 400);
  const r = await c.env.DB.prepare('INSERT INTO pedidos (cliente) VALUES (?) RETURNING *').bind(body.cliente.trim()).all();
  return c.json(r.results[0], 201);
});
```
- Validate every body; return proper status codes; never leak stack traces in responses.

## better-auth over D1 (when the spec has `auth.enabled`)
1. New migration with the better-auth core tables (`user`, `session`, `account`, `verification`) — generate with the better-auth CLI schema for the D1/SQLite dialect or hand-write matching its docs; then `app_provision_db`.
2. `worker/auth.ts`: create the better-auth instance with the D1 adapter (`database: { db: c.env.DB, type: 'sqlite' }` pattern via a per-request factory), `emailAndPassword: { enabled: true }`, `secret: env.BETTER_AUTH_SECRET` (add to `.dev.vars`).
3. Mount it in `worker/index.ts`: `app.on(['GET','POST'], '/api/auth/*', (c) => auth(c.env).handler(c.req.raw))`.
4. Export a `requireAuth` Hono middleware (reads the session; 401 when absent) and apply it to every protected entity route — the security audit checks for `requireAuth` usage.
5. Frontend: better-auth react client (`createAuthClient({ baseURL: '/api/auth' })`); gate protected screens with a `RequireAuth` wrapper component that redirects to the login screen.

## SPA routing
- `not_found_handling: "single-page-application"` serves `index.html` for unknown paths — client routes (react-router) just work. Never add server-side redirects for SPA routes.
- New screens: create in `src/screens/`, register in `src/screens/registry.ts` (id must match the spec screen id).

## Troubleshooting
- `vite dev` fails on config load → never edit `vite.config.ts` (MCP-managed); revert it.
- API 500 with `D1_ERROR: no such table` → migrations not applied locally: run `app_provision_db`.
- Type errors on `c.env.DB` → `worker/env.ts` must declare the binding; tsconfig.worker uses `@cloudflare/workers-types`.
- Deploy-time `database_id` placeholder errors are EXPECTED before publishing — the launch chain writes the real id; do not hand-edit it.
