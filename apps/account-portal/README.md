# CodeStudio Account Portal

A standalone browser SPA (React 19 + Vite 6 + Tailwind 4) for managing a CodeStudio
cloud account at **account.codestudio.dev**: sign-in (OAuth + email/password),
devices, billing, projects, hosted API docs, teams, and security.

It talks **directly** to the cloud Worker (`services/cloud-api`) over HTTPS with a
Bearer access token + a rotating refresh token in `localStorage` — it does **not**
use the Electron bridge (that's the desktop app). It is fully self-contained.

## Develop

```bash
pnpm dev:portal          # vite dev on :7318, proxies /v1 → the Worker
# point the proxy at a local worker:
CODESTUDIO_CLOUD_URL=http://localhost:8787 pnpm dev:portal
```

Email/password sign-in works in dev (proxied). OAuth needs real provider secrets on
the Worker (see below) and a matching `PORTAL_BASE_URL`, so the full OAuth round-trip
is only exercised against a deployed/secret-configured Worker.

## Build

```bash
pnpm build:portal        # → dist/account-portal
```

The bundle calls the API at `VITE_CLOUD_API_URL` (cross-origin in prod). Set it at
build time:

```bash
VITE_CLOUD_API_URL=https://codestudio-cloud-api.maiconspo6792.workers.dev pnpm build:portal
```

If unset, requests are relative (`/v1/...`) — only correct when the portal is served
from the same origin as the API (or behind a proxy).

## Deploy (Cloudflare Pages)

- **Build command:** `pnpm build:portal`
- **Build output directory:** `dist/account-portal`
- **Environment variable:** `VITE_CLOUD_API_URL` = the Worker's public URL.
- `public/_redirects` ships an SPA fallback (`/* /index.html 200`) so deep links and
  the OAuth handoff (`/auth/done#handoff=…`) survive a hard refresh.
- Custom domain: `account.codestudio.dev` (must be in the Worker's `ALLOWED_ORIGINS`).

## Worker config this portal depends on

Already set in `services/cloud-api/wrangler.jsonc` (vars):
- `ALLOWED_ORIGINS` includes `https://account.codestudio.dev` (CORS).
- `PORTAL_BASE_URL` = `https://account.codestudio.dev` (OAuth `flow=portal` redirect target).
- `OAUTH_PUBLIC_BASE_URL` = the Worker URL (provider callback base).

Secrets to set with `wrangler secret put` (OAuth stays 404 / fail-soft until then):
- `OAUTH_STATE_SECRET`
- `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`
- `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET`
- `MS_OAUTH_CLIENT_ID` / `MS_OAUTH_CLIENT_SECRET` (+ optional `MS_OAUTH_TENANT`)

### Provider callback URLs to register
`<OAUTH_PUBLIC_BASE_URL>/v1/auth/oauth/<provider>/callback`, e.g.:
- Google:    `https://<worker>/v1/auth/oauth/google/callback`
- GitHub:    `https://<worker>/v1/auth/oauth/github/callback`
- Microsoft: `https://<worker>/v1/auth/oauth/microsoft/callback`
