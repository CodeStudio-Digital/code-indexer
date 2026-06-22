# CodeStudio Cloud — Go-Live Configuration Guide

Everything in code is built, tested, and **deployed**. This guide lists only what
**you** must configure on your accounts (Cloudflare / Google / GitHub / Azure /
Stripe) to turn the remaining features fully on. Each item degrades gracefully
until configured (the app keeps working; only that feature is off).

> Run all `wrangler` commands from `services/cloud-api/` with the CodeStudio
> account selected:
> ```bash
> cd services/cloud-api
> export CLOUDFLARE_ACCOUNT_ID=0748c7a37faefcdbd0b2ab71580791cd   # PowerShell: $env:CLOUDFLARE_ACCOUNT_ID="0748c7a37faefcdbd0b2ab71580791cd"
> ```

---

## ✅ Already live (no action needed)

- **Worker** `codestudio-cloud-api` deployed → `https://codestudio-cloud-api.maiconspo6792.workers.dev`
  (auth, email verify, personal + org sync, hosted docs, sharing, backups, teams,
  billing routes, **OAuth routes** (fail-soft), **device identity**). D1 migrations
  `0001–0016` applied to production.
- **Portal** (account area) deployed → `https://codestudio-account-portal.pages.dev`
- **Secrets already set:** `ACCESS_SIGNING_SECRET`, `IP_HASH_SALT`, `SHARE_SIGNING_PRIVKEY`.
- **Public vars already set** (`wrangler.jsonc`): `APP_BASE_URL`, `SHARE_BASE_URL`,
  `EMAIL_FROM`, `ALLOWED_ORIGINS` (incl. `account.codestudio.dev`),
  `OAUTH_PUBLIC_BASE_URL`, `PORTAL_BASE_URL`, Cloudflare **EMAIL** binding.

---

## 1) OAuth sign-in (Google / GitHub / Microsoft) — enables browser login

Until set, the provider buttons return `404` (fail-soft) and email/password login
still works. The **redirect/callback URL to register** in every provider is:

```
https://codestudio-cloud-api.maiconspo6792.workers.dev/v1/auth/oauth/<provider>/callback
```
(`<provider>` = `google` | `github` | `microsoft`)

### 1a. State signing secret (required once, for any provider)
```bash
wrangler secret put OAUTH_STATE_SECRET     # paste: openssl rand -hex 32
```

### 1b. Google
1. Google Cloud Console → **APIs & Services → OAuth consent screen** (External, add your domain).
2. **Credentials → Create credentials → OAuth client ID → Web application**.
3. Authorized redirect URI: `…/v1/auth/oauth/google/callback` (above).
4. Then:
   ```bash
   wrangler secret put GOOGLE_OAUTH_CLIENT_ID
   wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET
   ```

### 1c. GitHub
1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**.
2. Authorization callback URL: `…/v1/auth/oauth/github/callback`.
3. Then:
   ```bash
   wrangler secret put GITHUB_OAUTH_CLIENT_ID
   wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
   ```

### 1d. Microsoft
1. Azure Portal → **App registrations → New registration** → Web → redirect
   `…/v1/auth/oauth/microsoft/callback`.
2. **Certificates & secrets → New client secret**.
3. (Recommended) **Token configuration → add optional claim `xms_edov`** so the
   worker can trust the verified email and link accounts; without it Microsoft
   logins always create a fresh account (safe, but no auto-link).
4. Then:
   ```bash
   wrangler secret put MS_OAUTH_CLIENT_ID
   wrangler secret put MS_OAUTH_CLIENT_SECRET
   # optional, if you restrict to a single tenant (default is "common"):
   # add  "MS_OAUTH_TENANT": "<tenant-id>"  to wrangler.jsonc vars
   ```

After setting secrets: `wrangler deploy` (picks up new secrets immediately; no code change).

**Verify:** open `…/v1/auth/oauth/google/start?flow=portal` in a browser → it should
302 to Google (not 404).

---

## 2) Portal custom domain → `account.codestudio.dev`

The worker already redirects the portal OAuth flow to `PORTAL_BASE_URL`
(`https://account.codestudio.dev`). Map that domain to the Pages project so the
handoff lands:

1. Cloudflare Dashboard → **Workers & Pages → codestudio-account-portal → Custom domains → Set up a custom domain**.
2. Enter `account.codestudio.dev` (the `codestudio.dev` zone must be on this account; Pages creates the DNS record).

Until mapped, the portal works at `codestudio-account-portal.pages.dev`, but
**OAuth `flow=portal` will redirect to `account.codestudio.dev`** — so map the
domain before relying on browser OAuth from the web portal. (Desktop OAuth uses
the loopback and does not need the domain.)

---

## 3) Stripe — live billing (Pro + Teams per-seat)

Until set, `billing.checkout` / `billing.portal` return `501 billing_not_configured`
(the UI shows a friendly "billing not configured" notice; everything else works).

1. **Secret key:** Stripe Dashboard (live mode) → Developers → API keys →
   ```bash
   wrangler secret put STRIPE_SECRET_KEY     # sk_live_...
   ```
2. **Products & prices:** create a **Pro** recurring price and a **Teams** recurring
   **per-seat** price (quantity-based). Copy their price ids and add to
   `services/cloud-api/wrangler.jsonc` `vars` (they are not secret):
   ```jsonc
   "STRIPE_PRO_PRICE_ID": "price_...",
   "STRIPE_TEAMS_PRICE_ID": "price_..."
   ```
   (Teams billing sends `quantity = writer count`; **viewers are free** — owner/admin/member are billable seats.)
3. **Webhook:** Stripe → Developers → Webhooks → **Add endpoint**:
   - URL: `https://codestudio-cloud-api.maiconspo6792.workers.dev/v1/billing/webhook`
   - Events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`.
   - Copy the **Signing secret** →
     ```bash
     wrangler secret put STRIPE_WEBHOOK_SECRET   # whsec_...
     ```
4. `wrangler deploy`.

**Verify:** as a signed-in user, trigger checkout from the app/portal → you reach a
Stripe-hosted page; after paying (test card in test mode) the webhook updates the
plan (audit log shows `billing_webhook_applied` / `org_billing_webhook_applied`).

---

## 4) Turnstile (optional) — bot protection on email/password

Email/password login already works without it (protected by per-IP rate limiting).
Add Turnstile if you want a bot challenge on the **web portal's** email/password form:

1. Cloudflare → **Turnstile → Add widget** → copy **Site key** + **Secret key**.
2. Worker: `wrangler secret put TURNSTILE_SECRET` → `wrangler deploy`.
3. Portal: rebuild with the site key and redeploy:
   ```bash
   VITE_CLOUD_API_URL=https://codestudio-cloud-api.maiconspo6792.workers.dev \
   VITE_TURNSTILE_SITEKEY=<site-key> pnpm build:portal
   wrangler pages deploy dist/account-portal --project-name codestudio-account-portal --branch main --commit-dirty=true
   ```
   (The widget is a no-op unless `VITE_TURNSTILE_SITEKEY` is set, matching the worker.)

> ⚠️ Set BOTH together. If you set `TURNSTILE_SECRET` on the worker but the portal
> has no site key, email/password sign-in on the portal will start failing with
> `turnstile_failed` (the worker would require a token the portal isn't sending).

---

## 5) Email sender (verify it's onboarded)

`EMAIL_FROM = no-reply@public.codestudio.digital` and the Cloudflare **EMAIL**
binding are configured. Confirm in Cloudflare **Email → Email Sending** that the
sender domain is verified and the address is in `allowed_sender_addresses`
(verification + password-reset emails depend on it).

---

## Priority order

1. **OAuth (§1) + portal domain (§2)** — together they turn on browser login + the web account area (the headline of P7).
2. **Stripe (§3)** — turns on paid upgrades (Pro / Teams). Needed for revenue.
3. **Turnstile (§4)** — optional hardening.
4. **Email (§5)** — verify; likely already working.

After §1–§3, re-run `wrangler deploy` once and the cloud is fully live. No code
changes are required for any of the above — only secrets/vars/console setup.
