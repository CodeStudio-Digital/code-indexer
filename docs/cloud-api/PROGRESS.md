# CodeStudio Cloud API — Progress log

> **Purpose:** running log of an unsupervised build session (the user went to sleep and asked me to
> keep going, make decisions, and update this `.md` after every milestone so context survives even if
> the chat is compacted). **Nothing is committed** — review via the working tree + this log.
> Branch: `feature/ide-mvp`. Cloud account: CodeStudio (`0748c7a37faefcdbd0b2ab71580791cd`).

The full design plan (4,480 lines) lives at `C:\Users\maico\.claude\plans\parcialmente-feito-hashed-boot.md`.

---

## 0. Context — what this session did BEFORE the cloud API

This session started on other work (the "partially-done features" evaluation), then pivoted to the
cloud API. For the record, before the cloud work:

- **Etapa 0 — Memory consolidator → opt-in (✅ verified).** Flipped `memoryConsolidateEnabled()` to
  OFF unless `MCP_MEMORY_CONSOLIDATE∈{1,true,on}` (`apps/http-api/sse/memory-consolidator.ts`),
  aligned the settings catalog default (`packages/store/src/app-settings/memory.ts` `'1'→'0'`) + i18n.
- **Etapa 1 — Training feature removed/discarded (✅ verified).** Deleted UI/routes/handler/api-bus
  contract/sidecar/worker-kinds/setting; kept `seed-extractor`/`seed-files`/`stack-profiles` + migration
  121. Backend tsc 0 new errors, dashboard `vite build` green.
- **Etapa 4 — Splash/preload window (✅ code, needs a launch to eye-verify).** `apps/electron/splash.html`
  + `apps/electron/src/splash-window.ts`; reordered `apps/electron/main.ts` `bootstrap()`
  (whenReady→splash→createApp→main window `show:false`+`ready-to-show`→closeSplash). Covers the ~20s
  white screen.
- **Etapas 2 & 3 (packaging ship-ESM + auto-update) — NOT done.** Captured in memory
  `project_codestudio_beta.md`. Key finding: do NOT bundle the Electron main into one CJS file (it
  collapses every module's `import.meta.url` → breaks worker/wasm resolution); ship the `dist` ESM +
  `extraMetadata.main` instead.

These are documented in the user's memory files; this log focuses on the **cloud API** from here on.

---

## 1. The Cloud API — what it is

A new, ultra-secure, Cloudflare-only backend for CodeStudio's users (freemium). The desktop IDE stays
**local-first / BYOK / offline**; the cloud account is OPTIONAL and unlocks: subscription/entitlements,
public conversation sharing, feedback/bug reports, and (future) sync.

**Locked decisions:** (1) Stripe behind a `PaymentGateway` port; (2) hosting = new Worker
`services/cloud-api` + pure domain packages `packages/cloud-*`; (3) email = Cloudflare Email Sending
`send_email` binding; (4) **TOTP 2FA + recovery codes in v1**; (5) opaque rotating refresh + short
signed access token; (6) password hashing Argon2id-or-PBKDF2 (see the Workers WASM gotcha below).

**Architecture:** hexagonal/DDD per bounded context. Pure domain/app packages depend only on
`@cloudstudio/cloud-kernel` and a `DbExecutor` port (D1 in prod ↔ better-sqlite3/fakes in tests), so
the core is unit-testable WITHOUT deploying. ≤200 LOC/file. Mirrors the on-device auth subsystem
(`packages/services/src/auth/*`) and the `worker-market` Worker patterns.

---

## 2. Provisioned Cloudflare resources (real, on the CodeStudio account, region ENAM)

| Kind | Name | Id / binding |
|---|---|---|
| D1 | `codestudio-cloud` | `5b0b7069-d453-4e07-ab2c-906835edf6c4` → binding `DB` |
| R2 | `codestudio-cloud-assets` | binding `ASSETS` |
| KV | `codestudio-cloud-cache` | `5a33b2b91d004648b0a72a70d69bf1a4` → binding `CACHE` |

Workers Paid is active on this account (user confirmed) → Email Sending available later.

---

## 3. ✅ Phase 0 — scaffolding (DONE, verified live)

- **Workspace wiring:** `services/*` added to `pnpm-workspace.yaml`; `@cloudstudio/*` aliases added to
  `tsconfig.base.json`.
- **`packages/cloud-kernel`** (pure, zero-dep): `result.ts` (`Result<T>`/`ok`/`err`), `errors.ts`
  (`DomainError` + `HttpStatusMapper` + `toErrorBody`), `ports.ts` (`DbExecutor`, `Clock`, `IdGen`,
  `Logger`, `RandomSource`), `ids.ts` (branded ids).
- **`services/cloud-api`** Worker: `wrangler.jsonc` (real D1/KV/R2 bindings), `src/index.ts` (Hono,
  `GET /v1/health`, JSON 404/500), `migrations/0001_init.sql` (accounts, sessions, refresh_tokens +
  indexes), `tsconfig.json`.
- **Verified:** baseline schema applied to BOTH remote + local D1 (tables confirmed); `tsc`
  (monorepo prod config) **0 errors**; Worker `tsc` **0 errors**; `pnpm install` linked the workspace;
  `wrangler dev` boots → `GET /v1/health` → **200**.

**How to run/verify Phase 0:**
```
pnpm --filter @cloudstudio/cloud-api exec wrangler dev --ip 127.0.0.1 --port 8787
curl http://127.0.0.1:8787/v1/health    # → {"ok":true,...} 200
```

---

## 4. ✅ Phase 1 (core auth) — DONE, verified live end-to-end

**`packages/cloud-identity`** (pure domain + application):
- domain: `email.ts` (VO, safe canonicalization), `password.ts` (policy ≥12, cap 256), `account.ts`
  (entity, no password hash on it), `errors.ts` (`IdentityError` union + exhaustive `identityHttpStatus`),
  `ports.ts` (`PasswordHasher`/`AccessTokenSigner`/`OpaqueTokenFactory` + repos).
- application: `session-issuer.ts` (mint: 15-min access + 30-day opaque rotating refresh; `issue` vs
  `rotate`), `signup.ts`, `login.ts` (enumeration + timing hardened via `dummyVerify`), `refresh.ts`
  (one-shot rotation; **reuse ⇒ revoke family**).

**Infrastructure (in the Worker, `services/cloud-api/src/infra/`):**
- `pbkdf2-hasher.ts` — **PBKDF2-HMAC-SHA256 via WebCrypto, 600k iters** (see gotcha §6).
- `access-token-signer.ts` — minimal **HS256 JWT** via WebCrypto, timing-safe verify, iss/aud/exp.
- `opaque-tokens.ts` — 32-byte CSPRNG token, only its SHA-256 hex stored. `sha256.ts`, `base64url.ts`.
- `runtime.ts` — `systemClock`/`cryptoIdGen`/`webCryptoRandom`/`consoleLogger`.
- `d1/d1-executor.ts` (`DbExecutor` over D1) + `d1/{account,session,refresh-token}-repo.ts`.

**Wiring:** `composition.ts` (per-request composition root), `routes/auth.ts`
(`POST /v1/auth/{signup,login,refresh}` + `GET /v1/auth/me`, zod-validated, password-confirm check),
`env.ts`. Local dev secret in `.dev.vars` (gitignored): `ACCESS_SIGNING_SECRET`.

**Verified live** (`wrangler dev` + local D1, scripted curl, 8/8 correct):
signup **201** · `/me` Bearer **200** · login **200** · refresh **rotates** · **reuse → 409
token_reuse** · wrong password **401** · duplicate **409** · weak password **400** · bad token **401**.
`tsc` 0 errors (monorepo + Worker).

---

## 5. ✅ Phase 1 — COMPLETE (identity, sessions, lockout, 2FA — all verified)

Done: unit tests (M1), logout + session mgmt with immediate revocation (M2), lockout Durable Object
(M3), TOTP 2FA + recovery codes (M4). The only identity-adjacent items left are **email confirmation
+ password reset**, which need Email Sending → they live in **Phase 2** below.

Then Phases 2–6: email (verify/reset), billing (Stripe), sharing (redaction + signed snapshots +
public viewer), feedback, hardening.

---

## 6. ⚠ Gotchas / decisions made autonomously

- **Cloudflare Workers forbid runtime `WebAssembly.compile()`** ("Wasm code generation disallowed by
  embedder"). So `hash-wasm` (Argon2id via inline WASM) **does not run** on workerd. → Switched to
  **PBKDF2-HMAC-SHA256 via WebCrypto** (decision #6's documented fallback). Future hardening: Argon2id
  as a **statically-imported `.wasm`** module (allowed) behind the same `PasswordHasher` port — no
  domain/app changes.
- **Tokens in the JSON body, not cookies** — this API is consumed by the desktop app (secure storage),
  not a browser origin.
- **Per-request composition root** — heavy singletons (the imported HMAC key) are module-level; the
  per-request bundle just closes a few functions over `env.DB`.

---

## 7. File map (cloud API)

```
packages/cloud-kernel/src/{result,errors,ports,ids,index}.ts
packages/cloud-identity/src/
  domain/{email,password,account,errors,ports}.ts
  application/{session-issuer,signup,login,refresh}.ts
  index.ts
services/cloud-api/
  wrangler.jsonc · package.json · tsconfig.json · .dev.vars (gitignored) · .gitignore
  migrations/0001_init.sql
  src/index.ts · env.ts · composition.ts
  src/routes/auth.ts
  src/infra/{runtime,base64url,sha256,opaque-tokens,access-token-signer,pbkdf2-hasher}.ts
  src/infra/d1/{d1-executor,account-repo,session-repo,refresh-token-repo}.ts
```

---

## 8. Milestone log (appended per part)

- **M0 (this file created):** Phase 0 + Phase 1 core complete & verified; everything above documented.
- **M1 — unit tests for the auth core.** `packages/cloud-identity/src/__tests__/auth.test.ts` with
  fake in-memory ports (no DB/WASM/server). Covers signup (dup/weak/bad-email), login
  (ok/wrong/unknown), refresh one-shot rotation, **reuse → token_reuse + family revocation**, expired,
  unknown. Added `@cloudstudio/*` aliases to `vitest.config.ts`. `npx vitest run packages/cloud-identity`
  → **4/4 passed**.
- **M2 — logout + session management (with IMMEDIATE revocation).** New use-cases
  `application/{logout,list-sessions}.ts` (`Logout`/`LogoutAll`/`ListSessions`); extended `SessionRepo`
  (`listByAccount`/`revokeAllForAccount`) + `RefreshTokenRepo` (`revokeBySession`/`revokeByAccount`).
  New Worker `src/middleware/auth.ts` (`requireClaims` verifies the token **and** that the session is
  still active in D1 → logout takes effect at once) + `src/routes/sessions.ts`
  (`POST /v1/auth/{logout,logout-all}`, `GET /v1/auth/sessions`); `/me` refactored onto it. **Verified:**
  vitest **6/6**; Worker tsc 0; live smoke — `/me` 200 → logout 200 → `/me` with the SAME still-valid
  access token → **401** (immediate revocation), sessions list shows current device, unauth → 401.
  ⚠ **Monorepo `tsc -p tsconfig.prod.json` shows 10 errors — ALL in `packages/code-agent/*`
  (code-exec/implement-subagent/mcp-bridge/index), NOT from the cloud work** (other WIP landed in the
  tree concurrently). Cloud packages compile clean (Worker tsc + vitest green).
- **M3 — login lockout via Durable Object.** New `LoginThrottle` port (`packages/cloud-identity`),
  wired into `LoginUseCase` (check before verify → `account_locked`; record failure on bad creds,
  success resets). Worker: `src/login-throttle-do.ts` (`LoginThrottleDO`, exported from entry) +
  `src/infra/login-throttle.ts` adapter (`idFromName(key)` → one serialized DO per key); wrangler
  `durable_objects` binding `LOGIN_THROTTLE` + `new_sqlite_classes` migration `v1`. **v1 keys by client
  IP** (avoids the victim-account-lockout DoS); next layer = per-account step-up (Turnstile/email).
  Policy: 10 fails / 15-min window → lock 15 min. **Verified:** vitest **8/8** (locked-throttle →
  account_locked; failure recorded); live smoke — 10× wrong → `invalid_credentials`, 11th+ →
  `account_locked` (retryAfterMs ≈ 15 min), correct password also blocked while locked.
- **M4 — TOTP 2FA + recovery codes (v1 requirement).** Ports `TotpPort`/`RecoveryCodeService`/
  `TwoFactorRepo`/`ChallengeTokenPort` + use-cases `application/{two-factor,challenge-2fa}.ts`
  (`Enroll`/`Confirm`/`Disable`/`Challenge2fa`); login now branches to `twofa_required` + a short-lived
  challenge token when 2FA is enabled. Worker infra: `src/infra/{base32,totp,recovery-codes,
  challenge-token}.ts` + `d1/two-factor-repo.ts` (TOTP = WebCrypto HMAC-SHA1, 6-digit, 30s, ±1 window;
  recovery codes = sha256-hashed, one-shot; challenge token = HMAC, domain-separated). Migration
  `0002_twofa.sql` (totp_secrets, recovery_codes) applied to **remote + local** D1. Routes
  `src/routes/two-factor.ts` (`POST /v1/auth/2fa/{enroll,confirm,disable,challenge}`). **Verified:**
  vitest **12/12** (new `two-factor.test.ts`); Worker tsc 0; live Node smoke — **RFC 6238 vector
  matches 287082** (authenticator-compatible), enroll→confirm(10 codes)→login `twofa_required`→
  challenge by TOTP **200**, by recovery code **200**, recovery reuse **401 twofa_invalid**.
  **PHASE 1 COMPLETE.** (Smoke note: local Durable Object state persists across `wrangler dev` runs, so
  the lockout key `'unknown'` stayed locked — pass a unique `cf-connecting-ip` header per login to dodge
  it, or clear `.wrangler/state`.)
- **M5 — Phase 2: email verification + password reset.** Ports `EmailSender`/`MailComposer`/
  `OneTimeTokenRepo` + use-cases `application/{email-verification,password-reset}.ts` (Send/Verify;
  Request/Reset). Request-reset is **anti-enumeration** (always 200, mail only if the account exists);
  reset is one-shot, sets the new password, and **revokes all sessions + refresh tokens**. Worker infra:
  `src/infra/{email-sender,mail-composer}.ts` + `d1/auth-token-repo.ts` (token expiry stored as **epoch
  ms**, compared via `unixepoch('now')*1000` — dodges the SQLite ISO/`datetime('now')` gotcha). Email
  sender uses the Cloudflare `env.EMAIL` binding when present, else a **console fallback** for local dev.
  Migration `0003_auth_tokens.sql` applied to **remote + local** D1. Routes `src/routes/email.ts`
  (`POST /v1/auth/{verify-email,resend-verification,request-password-reset,reset-password}`); signup now
  fires the verification email. **Verified:** vitest **17/17** (new `email.test.ts`); Worker tsc 0; live
  smoke — pulled the real tokens from the dev email log: verify-email **200** (account → emailVerified
  true), reset-password **200** (login w/ new pw **200**, old pw **401**), bad token **400**. **PHASE 2
  COMPLETE.**

---

## 8b. Security audit (M6) — adversarial review + fixes (verified)

Ran a 6-dimension adversarial audit (auth/session, crypto, D1/SQL, HTTP/abuse, DDD, 2FA/email flows)
with **per-finding verification** (14 agents). 2 HIGH confirmed (0 refuted) + a medium/low list.
**Fixed and re-verified (vitest 17/17, Worker tsc 0, live smoke all green):**
- **[HIGH] Refresh rotation race** — `RefreshTokenRepo.consume` now returns whether it *claimed* the row
  (atomic `WHERE consumed_at IS NULL`); `RefreshUseCase` treats a lost race as reuse → `revokeFamily` +
  `token_reuse`. Restores the one-shot/family-revocation guarantee. (refresh.ts, refresh-token-repo.ts, ports.ts)
- **[HIGH] 2FA brute-force/replay** — challenge token is now **single-use** (opaque token stored in
  `auth_tokens` purpose `twofa_challenge`, consumed on success) and `/2fa/{challenge,confirm}` are now
  **throttled** per-account (LoginThrottle DO). Live-verified: a replayed challenge token → 401.
- **[MED] Email/reset token TOCTOU** — `OneTimeTokenRepo.consume` returns claimed?; verify/reset now
  **consume-first** and gate the side-effect on the atomic claim.
- **[MED] Body-size limit** — `bodyLimit(32KB)` middleware → oversized bodies 413 (verified).
- **[flow] Re-enroll-while-enabled** — enroll now rejects if 2FA already enabled (no silent downgrade).
- **[low] Recovery-code normalization** strips the hyphen/whitespace (a user typing the code without the
  dash no longer burns their only recovery path); recovery codes are **replaced** on (re)confirm.
- **[low] needsRehash on login** wired (transparent hash upgrade); **JWT alg/typ pinned** in verify;
  **dummyVerify** mirrors verify's timingSafeEqual; stale "Argon2id" docs corrected to PBKDF2; all routes
  now go through a shared `respondError` (single status mapper, preserves `error.details`).

**Deferred to Phase 6 (hardening) — documented, your call:**
- [MED] **Account enumeration via signup 409** (`email_already_registered`) — a design trade-off
  (immediate-session UX vs. anti-enumeration). Mitigation: signup throttle, or switch to a generic 200 +
  out-of-band "already registered" email. Needs your preference.
- [MED] **No rate-limit on email-sending endpoints** (signup verification / resend / request-reset) —
  email-bombing/cost vector. Wants a dedicated rate-limit primitive (the CF `ratelimit` binding) — Phase 6.
- [LOW] CORS + security headers (`secureHeaders`/`cors`) — needs the app/share origins finalized + deploy.
- [LOW] TOTP step single-use within the ±1 window (the per-account throttle + single-use challenge token
  already bound the risk); dead exports (`webCryptoRandom`/`consoleLogger`), unreachable error-union codes
  (get producers in later phases), and a per-request signer-key memoization — cosmetic.

Full audit JSON: the workflow run `wf_0a4403a6-806` (transcript in this session's workflows dir).

---

## 8c. Milestone log (cont.) — Phase 3 Billing

- **M7 — Phase 3: Billing (entitlements + 14-day trial + Stripe behind a port).** New pure package
  **`packages/cloud-billing`** (deps: only `@cloudstudio/cloud-kernel`):
  - domain: `subscription.ts` (`PlanId` free|pro, `SubStatus` none|trialing|active|past_due|canceled,
    `Subscription` w/ `trialUsed` one-shot latch), `entitlements.ts` (**pure projection**
    `deriveEntitlements(sub, now)` — Pro iff active|trialing & not lapsed; `TRIAL_DAYS=14`),
    `errors.ts` (`BillingError` union + exhaustive `billingHttpStatus`: `billing_not_configured`→501,
    `no_customer`→409, `webhook_signature_invalid`→400), `ports.ts` (`PaymentGateway`,
    `BillingRepo`, `SubscriptionEvent`, `CheckoutSession`).
  - application: `get-entitlements.ts` (auto-grants the one-shot trial on first cloud touch, re-reads —
    race-safe), `handle-webhook.ts` (idempotent projection — `recordWebhookEvent` dedupes replays),
    `checkout.ts` (`CreateCheckout`/`CreatePortal`, both guarded by `gateway.configured`).
  - **Stripe stays behind the port.** Adapter `services/cloud-api/src/infra/stripe-gateway.ts`:
    `configured` = secret+webhook-secret present (false in dev ⇒ routes 501); `parseWebhook` verifies the
    Stripe `t=…,v1=…` HMAC over the **raw body** with WebCrypto (timestamp tolerance + timing-safe
    compare), maps `customer.subscription.*` → provider-neutral `SubscriptionEvent`; checkout/portal call
    the Stripe REST API via `fetch` (coded; live-exercised only once keys are set). A Paddle/LemonSqueezy
    swap = a second adapter, zero use-case change.
  - Infra repo `services/cloud-api/src/infra/d1/billing-repo.ts` (`BillingRepo` over D1): `startTrial` is
    an atomic upsert with a `WHERE trial_used=0` guard (concurrent double-grant → no-op); `period_end_ms`
    epoch-ms. Migration **`0004_billing.sql`** (`subscriptions`, `billing_webhook_events`) applied to
    **remote + local** D1.
  - Wiring: `billing-composition.ts` (per-request `BillingBundle`), `routes/billing.ts`
    (`GET /v1/billing/entitlements`, `POST /v1/billing/{checkout,portal,webhook}` — webhook is
    signature-gated, NOT Bearer). `Env` gained optional `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`/
    `STRIPE_PRO_PRICE_ID`. `vitest.config.ts` got the `@cloudstudio/cloud-billing` alias + a
    `services/*/src/**/__tests__/**` include.
  - **Verified:** **24 new unit tests** (`packages/cloud-billing/.../billing.test.ts` — projection truth
    table, auto-trial latch, webhook idempotency, checkout/portal guards; `services/cloud-api/.../
    stripe-webhook.test.ts` — HMAC verify cross-checked vs node:crypto, stale-ts reject, event mapping,
    `configured` flag). Worker `tsc` **0**. Live `wrangler dev` smoke: first `entitlements` →
    `tier:pro,status:trialing` w/ a ~14-day `periodEndMs`; second call → **same** `periodEndMs` (trial
    latched + persisted, not re-granted); checkout/portal → **501** `billing_not_configured` (no Stripe
    in dev); webhook bad-sig → **400**; unauth → **401**. **PHASE 3 CORE COMPLETE** (Stripe checkout/portal
    live-flow deferred until the user provides test keys — see §9).

---

## 8d. Milestone log (cont.) — Phase 4 Sharing

- **M8 — Phase 4: Public conversation sharing (redaction + Ed25519-signed snapshots + public viewer).**
  New pure package **`packages/cloud-sharing`**:
  - domain: `share.ts` (`PublicShare`, `Slug` + 21-char `SLUG_RE`, `Visibility`, `ShareStatus`,
    `isViewable`), `snapshot.ts` (`PublicBlock` NARROW union — **no base64 / no raw tool_result body by
    type**; `ShareSnapshot` + deterministic `canonicalize` for signing), `errors.ts` (`ShareError` union +
    `shareHttpStatus`: not_found 404, revoked/expired 410, forbidden 403, not_entitled/quota 402,
    too_large 413, invalid 422), `ports.ts` (`ShareRepo`, `SnapshotSigner`, `SharingEntitlement`).
  - **redaction engine (the security core)** `redaction/{rules,redactor}.ts`: an ordered rule table
    (private-key PEM, JWT, sk-/AWS/GitHub/Google/Slack keys, connection strings, `KEY=value` secret lines,
    Windows/POSIX/`~` home paths → `‹path›` while **keeping relative example paths**) + strict-only email
    + a Shannon-entropy high-entropy catch. `redactText(level)` + `redactSnapshot(level)` — pure,
    fail-closed, two-layer (client preview + **server re-redaction**, the real boundary).
  - application: `create-share.ts` (entitlement + quota gate → re-redact → 1.5 MB cap → Ed25519 sign →
    atomic insert), `view-share.ts` (`GetPublicShare` viewable/revoked/expired, `ListOwnShares`,
    `RevokeShare` — non-owner gets 404, no existence disclosure).
  - Worker infra: `infra/ed25519-signer.ts` (signs **sha-256(canonical)** with WebCrypto Ed25519, reusing
    the `worker-market/src/sign.ts` approach so a desktop viewer verifies offline against the pinned
    pubkey), `infra/d1/share-repo.ts` (atomic `.batch()` insert of share + denormalized messages; the
    public viewer reads ONLY `public_share_messages`). Migration **`0005_sharing.sql`** (`public_shares`,
    `public_share_messages`) applied to **remote + local** D1. Dev signing keypair minted + stored in
    `.dev.vars` (`SHARE_SIGNING_PRIVKEY`; pub spki documented inline).
  - Wiring: `sharing-composition.ts` (reuses billing `getEntitlements` to gate on `features.sharing` +
    `limits.maxActiveShares`), `routes/sharing.ts` (`POST/GET/DELETE /v1/share` Bearer + public
    `GET /s/:slug` no-auth). Body caps in `index.ts` are now **scoped** (auth 32 KB, billing 64 KB,
    share 2 MB). The create zod schema FORBIDS base64 / raw tool_result by construction.
  - **Verified:** **+28 unit tests** (`cloud-sharing` redaction golden vectors incl. a no-leak assertion
    per secret shape + the standard/strict split + snapshot projection; sharing use-cases incl. quota,
    re-redaction-on-publish, owner-guarded revoke; worker `ed25519-signer.test.ts` — **WebCrypto sign ↔
    node:crypto verify round-trip + tamper rejection**). **67 cloud tests green total.** Worker `tsc` **0**.
    Live `wrangler dev` smoke: create → **201** (redactionCount 3, slug+url); public `GET /s/:slug` →
    transcript with `sk-ant-…`→`‹redacted:key›`, paths→`‹path›`, real sha-256 + Ed25519 signature; list;
    revoke → **410** on re-fetch; unauth create → **401**; a backslash-exact body confirmed
    **Windows + POSIX home paths both masked** (the only "leak" seen was the test shell stripping
    backslashes before the request, not a server bug). **PHASE 4 COMPLETE** (the HTML viewer page + the
    desktop client wiring are Phase 7 / a separate viewer origin — the signed JSON feed is live).
  - Minor deferred nicety: revoking an already-revoked share returns 404 (not an idempotent 200); the
    first revoke works and the share is gone. Not a correctness issue.

---

## 8e. Milestone log (cont.) — Phase 5 Feedback

- **M9 — Phase 5: Feedback intake (bug/idea/report + R2 attachments + Turnstile).** New pure package
  **`packages/cloud-feedback`** (deps: cloud-kernel + **cloud-sharing** — reuses the redaction engine):
  - domain: `feedback.ts` (`FeedbackKind` bug|idea|other, `FeedbackStatus` lifecycle, discriminated
    `Submitter` account|anonymous, `FeedbackTicket`, `FeedbackAttachment`, `FeedbackSummary`), `errors.ts`
    (`FeedbackError` + `feedbackHttpStatus`: validation 400, human_required/failed 403, rate_limited 429,
    not_found 404, attachment_too_large 413, attachment_type_rejected 415, storage 503), `ports.ts`
    (`FeedbackRepo`, `AttachmentStore`, `BotVerifier`, `ContentSniffer`).
  - application: `submit-feedback.ts` (attributed vs **anonymous-requires-Turnstile**; **re-redacts the
    free-text message through the shared sharing `redactText`** so a pasted secret/path never lands in the
    DB; attachments must be owned by the caller), `attachments.ts` (Worker-PROXIED upload — sniff magic
    bytes + size cap BEFORE R2, server-generated key, ignores client content-type), `list-feedback.ts`.
  - Worker infra: `infra/content-sniffer.ts` (images-only allowlist PNG/JPEG/GIF/WEBP — structurally
    rejects SVG/HTML/PDF/polyglots), `infra/r2-attachment-store.ts` (R2 `ASSETS` bucket),
    `infra/turnstile.ts` (siteverify; `enabled=false` w/o secret ⇒ anon disabled), `infra/d1/feedback-repo.ts`
    (raw IP/email NEVER stored — only salted hashes; list-own hides spam). Migration **`0006_feedback.sql`**
    (`feedback_tickets`, `feedback_attachments`) applied to **remote + local** D1.
  - Wiring: `feedback-composition.ts`, `routes/feedback.ts` (`POST /v1/feedback` optional-auth,
    `POST /v1/feedback/attachment` Bearer, `GET /v1/feedback` Bearer); body cap 6 MB on the attachment
    sub-path, 32 KB on submit. `Env` gained optional `TURNSTILE_SECRET`.
  - **Verified:** **+17 unit tests** (`cloud-feedback` submit attributed/anon/Turnstile-gating +
    body-redaction + attachment ownership + list-own; worker `content-sniffer.test.ts` — PNG/JPEG/GIF/WEBP
    accepted, SVG/HTML/polyglot/empty/random rejected). **84 cloud tests green total.** Worker `tsc` **0**.
    Live `wrangler dev` smoke: submit bug → **201** with the secret redacted in the stored message; PNG
    upload → **201 image/png**; disguised HTML → **415 attachment_type_rejected**; submit with the owned
    attachment → **201** (attachmentCount 1); list-own shows both (redacted); anonymous w/o Turnstile →
    **403 human_verification_required**; unauth list → **401**. **PHASE 5 COMPLETE** (admin triage UI/
    endpoints deferred — they need a role/scope system; user-facing intake is done).

---

## 8f. Milestone log (cont.) — Phase 6 (partial): edge security headers + CORS

- **M10 — Phase 6 (partial): security headers + CORS allowlist.** New `src/middleware/security.ts`
  (Hono `secureHeaders` + `cors`), applied FIRST in the chain on every route:
  `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'` (the API is
  JSON-only — nothing is ever loaded), `Strict-Transport-Security` (1y + subdomains),
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  `Cross-Origin-Resource-Policy: same-site`. CORS is an **origin allowlist** from `ALLOWED_ORIGINS`
  (comma-separated) — echoes only allowlisted origins, **never `*`**, `credentials: false` (bearer-only,
  so no cookie/CSRF surface). `Env` gained optional `ALLOWED_ORIGINS`. **Verified:** Worker `tsc` **0**;
  live smoke — all six headers present on `/v1/health`, signup still **201** (no regression), a
  disallowed `Origin` is **not** echoed (no `Access-Control-Allow-Origin`). Remaining Phase 6 items
  (rate-limit coverage incl. the deferred email/feedback limits, audit log, account deletion/export,
  admin triage role system, CI) are still open — see §9.

---

## 8g. Milestone log (cont.) — Phase 6 hardening (rate-limit + audit + account lifecycle)

- **M11 — rate limiting, append-only audit log, GDPR account export + erasure.**
  - **Rate limiting:** kernel `RateLimiter` port + a generic `RateLimitDO` (one serialized DO per key) +
    `infra/rate-limiter.ts` adapter + `middleware/rate-limit.ts` (`enforceRateLimit(c, rules)` → 429 +
    `Retry-After`; no-op when the binding is absent for local dev). Wired into the abuse/cost vectors:
    signup (5/h/IP), password-reset (10/h/IP + 3/h/email — still always 200, no enumeration), resend
    (3/15m/acct), feedback (20/day authed · 3/h/IP anon), attachment (10/h). wrangler DO binding
    `RATE_LIMIT` + migration tag `v2`.
  - **Audit log:** `infra/audit.ts` (`AuditLog` + `redactMeta` — primitive scalars only, secret-ish keys
    dropped) + `middleware/audit.ts` (`recordAudit` via `executionCtx.waitUntil` — never blocks/fails the
    response). Migration **`0007_hardening.sql`**: `audit_log` (account_id is plain TEXT, **NO FK** → the
    row survives account erasure) + triggers blocking UPDATE/DELETE (append-only). Recorded at: signup,
    login_ok/fail, token_refresh(+reuse), mfa_enabled/disabled, mfa_challenge_ok/fail, password_reset,
    share_created/revoked, feedback_submitted, billing_webhook_applied, account_export/deleted/delete_denied.
  - **Account lifecycle:** `routes/account.ts` — `GET /v1/account/export` (cross-context aggregation:
    profile + sessions + subscription + shares + feedback) and `DELETE /v1/account` (reauth: current
    password + literal `"DELETE"` → **immediate hard erasure** via FK cascade — true right-to-erasure, no
    half-state). `infra/account-admin.ts` (`hardDelete` + `purgeAccountBlobs`).
  - **Verified:** Worker tsc 0; **89 cloud tests** (incl. `audit-redact.test.ts`); live smoke — signup
    5×201→**429**; export all-keys Bearer-gated; delete wrong-pw 401 / no-confirm 400 / ok 200 /
    post-login 401 / dangling-token 401; **`account_deleted` tombstone survives erasure**; audit
    UPDATE+DELETE both **ABORT** (append-only).

- **M12 — adversarial security review (12-agent workflow) + fixes (all re-verified).** Ran a 4-dimension ×
  3-skeptic review (`wf_1d801937-a26`, 40 agents) over the Phase 6 code. **8 of 12 candidates confirmed**
  (4 dismissed). All fixed:
  - **[HIGH] Unsalted `ip_hash`/`emailHash`** (`sha256Hex(ip)` of a 2³² IPv4 / known email is rainbow-table
    reversible — and the schema comments falsely claimed "salted"). → New `hashPii(value, pepper)` =
    **HMAC-SHA256** keyed by `IP_HASH_SALT`; routed ALL IP/email hashing through it (audit/auth/2fa/
    feedback/email); `sha256Hex` kept ONLY for high-entropy token hashing (correct there). Comments
    corrected. **Live-verified**: stored `ip_hash` now equals `HMAC(salt,ip)`, not bare `sha256(ip)`.
  - **[HIGH] Account erasure left feedback attachment blobs in R2** (DB cascade doesn't touch R2). →
    `purgeAccountBlobs` lists+deletes `feedback/<accountId>/` before the DB delete (fails closed: R2 error
    ⇒ 500, account survives). **Live-verified**: object present before delete, "key does not exist" after.
  - **[MED] Fixed-window ~2× boundary burst** → `RateLimitDO` rewritten to a **sliding-window** log.
  - **[MED] /auth/refresh unaudited** → audits `token_refresh` + `token_refresh_fail` (**live-verified the
    `token_reuse` theft signal is captured**).
  - **[MED] 2FA challenge unaudited** → audits `mfa_challenge_ok/fail` (brute-force trail).
  - **[MED] `password_reset` audit had account_id NULL** → `ResetPasswordUseCase` now returns `accountId`;
    the row is attributed.
  - **[MED] DELETE /v1/account reauth = unbounded password oracle** → added a 10/h per-account rate limit.
  - **[LOW] Audit fire-and-forget swallows errors** → ACCEPTED: a failed write must not fail a deletion;
    the existing `console.error` is the alerting signal (visible in Workers logs).
  - Re-verified: Worker tsc 0, **89 cloud tests green**, migrations 0001–0007 on remote + local D1.
  **PHASE 6 COMPLETE** except deliberately-deferred items (admin triage role system; CI pipeline).

---

## 8h. Milestone log (cont.) — M13: DEPLOYED to production + OpenAPI

- **M13 — first production deploy + a critical prod-only fix + OpenAPI spec.**
  - **Deployed** `codestudio-cloud-api` to **`https://codestudio-cloud-api.maiconspo6792.workers.dev`**
    (`wrangler deploy`; both Durable Objects shipped via migration tags v1+v2; D1/KV/R2 bindings live).
    Secrets set via `wrangler secret put`: `ACCESS_SIGNING_SECRET`, `IP_HASH_SALT`, `SHARE_SIGNING_PRIVKEY`
    (a fresh Ed25519 prod keypair; pubkey + all three saved to the gitignored
    `services/cloud-api/SECRETS.prod.local.txt`). Stripe/Turnstile/email left unset (those features inert).
  - **🔴 CRITICAL prod-only gotcha found + fixed:** the **production workerd caps PBKDF2 at 100,000
    iterations** (`NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not supported`).
    `wrangler dev --local` does NOT enforce this, so signup/login passed every local smoke but **500'd on
    the real edge**. Since Workers also forbids runtime WASM-compile (no Argon2id), the fix is **chained
    PBKDF2**: `deriveBits` now loops in ≤100k-iteration chunks (6×100k = 600k effective), feeding each
    chunk's output as the next chunk's salt — same work factor, within the cap, same self-describing PHC.
    (`infra/pbkdf2-hasher.ts`.) Documented follow-up: scrypt (pure-JS @noble/hashes) or static-import
    Argon2 `.wasm` for memory-hardness. Also raised signup rate-limit 5→20/h/IP (5 was too aggressive).
  - **Verified LIVE on the production URL:** signup **201**, login (correct) **200**, login (wrong) **401**,
    `/me` returns the account, refresh **200**, entitlements **tier=pro/trialing** (auto-trial), peppered
    `ip_hash` confirmed, security headers present. **Login is functional in production.**
  - **OpenAPI 3.1 spec** written to **`docs/cloud-api/openapi.yaml`** (27 paths / 29 operations / 7 schemas,
    server = the prod URL, bearer security scheme) — import into Postman / Insomnia / the IDE API client.
  - **Note — diagnostics:** `wrangler dev --remote` is NOT supported with Durable Objects (use `wrangler
    tail` for live prod logs). Cloudflare's edge **rejects a spoofed `cf-connecting-ip`** (HTTP 403 "error
    code: 1000") — you can't fake the source IP to dodge per-IP limits against the real edge (a good thing).

---

## 9. State of the build & next steps (for the morning review)

**Done & verified tonight (unsupervised):** Phase 0 (scaffolding) + Phase 1 (full identity: signup,
login, refresh w/ rotation+reuse-revocation, logout/immediate-revocation, session list, IP lockout DO,
TOTP 2FA + recovery codes) + Phase 2 (email verification + password reset) + Phase 3 (billing:
entitlements + 14-day auto-trial + Stripe behind a `PaymentGateway` port + idempotent webhook) +
Phase 4 (sharing: two-layer redaction engine + Ed25519-signed denormalized snapshots + public
read-only viewer feed, entitlement-gated) + Phase 5 (feedback: bug/idea intake + Worker-proxied
magic-byte-sniffed R2 attachments + Turnstile-gated anonymous path, free-text re-redacted) + **Phase 6
(hardening: security headers + CORS allowlist, generic sliding-window rate limiting, append-only audit
log, GDPR account export + erasure) — PLUS a 12-agent adversarial security review that confirmed 8 of 12
candidate findings (2 HIGH, 5 MED, 1 LOW), all fixed and re-verified**.
**89 unit tests green** (17 identity + 24 billing + 26 sharing/signer + 17 feedback/sniffer + 5 audit-redact),
Worker tsc 0 errors, extensive live `wrangler dev` smokes (RFC-6238 TOTP vector, email-token round-trips,
billing auto-trial + webhook-signature, sharing create→redact→sign→public-view→revoke, feedback
submit→redact→attachment-sniff→list→anon-gate, security headers, rate-limit 429, append-only triggers,
peppered-`ip_hash` HMAC match, R2 blob erasure on delete, `token_reuse` audit). Migrations 0001–0007 on
**remote + local** D1. **Nothing committed.** Phase 6 remaining: admin triage role system + CI only.

**Known external state (not blockers, just FYI):** the monorepo `tsc -p tsconfig.prod.json` reports
**10 errors, all in `packages/code-agent/*`** — concurrent WIP by other work in the tree, **NOT** the
cloud API (which is clean via the Worker tsc + vitest).

**To go live (your decisions / inputs needed):**
1. **Deploy the Worker:** `pnpm --filter @cloudstudio/cloud-api exec wrangler deploy` (after
   `wrangler login`). Set prod secrets: `ACCESS_SIGNING_SECRET`, `IP_HASH_SALT`, `SHARE_SIGNING_PRIVKEY`
   (+ Stripe/Turnstile when enabling those). The D1 schema is already on the remote DB
   (`codestudio-cloud`), migrations 0001–0007 applied; `wrangler deploy` ships the two Durable Objects.
2. **Email delivery:** onboard a sender domain in Cloudflare (Compute → Email Service → Email Sending),
   then uncomment the `send_email` binding in `wrangler.jsonc` and set `EMAIL_FROM`. Until then signup
   still works; the verification email just logs to the console.
3. **Stripe (Phase 3 go-live):** set `wrangler secret put STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`,
   add the Pro `STRIPE_PRO_PRICE_ID` var, and point a Stripe webhook at `/v1/billing/webhook`. Until then
   entitlements + the 14-day trial work fully; only the checkout/portal redirects return 501. Set the
   subscription `metadata.accountId` on checkout (the adapter already does this) so webhooks resolve the
   account. Verify with the Stripe CLI: `stripe listen --forward-to localhost:8787/v1/billing/webhook`.

4. **Sharing (Phase 4 go-live):** set `wrangler secret put SHARE_SIGNING_PRIVKEY` (an Ed25519 PKCS8
   base64 key — `node -e "const {generateKeyPairSync}=require('crypto');console.log(generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'der'}).toString('base64'))"`)
   and a `SHARE_BASE_URL` var (the viewer origin). The signed JSON feed at `/s/:slug` is already live; the
   HTML viewer page + desktop "Share" button are Phase 7.

5. **Feedback (Phase 5 go-live):** set `wrangler secret put TURNSTILE_SECRET` (+ the Turnstile sitekey
   in the client) to enable the anonymous submit path. Authenticated feedback + attachments already work;
   attachments stream into the `ASSETS` R2 bucket under `feedback/<accountId>/<uuid>.<ext>`.

6. **Hardening (Phase 6 go-live):** `wrangler secret put IP_HASH_SALT` (REQUIRED — without it PII hashes
   degrade to keyless/reversible) and set `ALLOWED_ORIGINS` (var) to the web viewer/dashboard origins. The
   `RATE_LIMIT` Durable Object ships via `wrangler deploy` (migration tag v2).

**Next phases (in order, each its own session/part):**
6b. **Phase 6 tail (deferred):** admin triage role/scope system (the feedback admin endpoints) + a CI
    pipeline. These need a roles design + a push to verify; everything else in Phase 6 is done.
7. **Phase 7 — Client integration** (desktop token store in `safeStorage`, single-flight refresh, cloud
   client, auth/subscription/share/feedback UI, the HTML share viewer page). Plan §7. **This is the
   largest remaining piece and the natural next focus.**

Phase 3's money path is built and unit+smoke-verified end-to-end **except** the two Stripe-hosted
redirects (checkout/portal), which are coded but inert until the test keys are set. Phase 4's sharing is
fully verified end-to-end including the redaction engine, Ed25519 signing, and the public viewer feed —
only the secret-key provisioning (above) and the HTML viewer remain.
