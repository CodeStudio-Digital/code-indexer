# CodeStudio — Path to Sellable (Next-Session Guide)

_Last updated: 2026-06-23. Companion to [`docs/cloud-api/GO-LIVE.md`](cloud-api/GO-LIVE.md)
(external config) — this doc is the broader plan to turn a feature-rich build into a
**sellable** product._

## TL;DR

The product is **feature-rich, the cloud backend is solid + deployed, and security
requirements are met** (R1–R10; R3/R9 fixed this cycle). It is **not yet shippable as
a paid product** — and the gap is **not features**. It's the *business surface* +
*release engineering*:

1. **Ship-engineering** — no code signing, no auto-update, desktop has no CI/build pipeline.
2. **Monetization loop** — Stripe not live; no in-app pricing/upgrade UX; no post-purchase activation.
3. **Trust/compliance** — no ToS/Privacy/EULA; no crash reporting; no support/status surface.
4. **Verification** — a large "build-verified, E2E-manual-pending" backlog + native-module (ABI) risk.
5. **Hygiene** — ~74 files uncommitted; `check:arch` red; 4 pre-existing tsc errors; CI only covers the cloud worker.

Fix these and CodeStudio is sellable. Below is the prioritized plan.

---

## 1. Where we are (snapshot)

| Surface | Built | Verified | Deployed | Tier-gated | Notes |
|---|---|---|---|---|---|
| Local IDE (editor/terminal/agent/company) | ✅ | partial (E2E manual) | ships in app | free | core |
| Cloud account/auth/OAuth (P7) | ✅ | ✅ (unit+wrangler E2E) | ✅ worker | n/a | OAuth secrets external-pending |
| Account portal (P7-C) | ✅ | ✅ build+login render | ✅ Pages (pages.dev) | n/a | custom domain pending |
| Cloud sync (env + collections P2) | ✅ | ✅ unit | ✅ worker | Pro (`sync`) server-side | secrets redacted client-side |
| Hosted API docs (P1) | ✅ | ✅ | ✅ | Pro (`apiDocs`) | |
| Backups (P3) | ✅ backend | ✅ backend | ✅ | Pro (`backup`) | client binary transport pending |
| Teams / per-seat billing (P4) | ✅ | ✅ unit | ✅ | Team (per-seat, viewers free) | Stripe live pending |
| Project library (P6-C) | ✅ | build-verified | n/a (desktop) | Pro/Team (`sync`) | E2E manual |
| API client (Postman) | ✅ | ✅ | n/a | free local | |
| **SSH client + vault** | ✅ P0–P6+SFTP+vault(personal/team/portal) | unit (57+ tests); **live E2E pending** | vault→worker | **vault sync = Pro/Team, server-gated ✅** | P7 keys + P8 + live E2E pending |
| **DB client** | ✅ P0–P2 (pg/mysql/sqlite) | unit (25 pure); **Electron runtime pending (ABI)** | n/a | **NOT gated (free local)** | P3 vault + P4 engines/export pending |

- **Repo:** branch `feature/ide-mvp`; last commit `11c15fb` folded in SSH/DB/providers; **~74 files uncommitted** (this cycle: cloud R3/R9, P6-C, P2, portal, db-drivers).
- **CI:** only `.github/workflows/cloud-api-ci.yml` (typecheck + tests + gitleaks for the worker). **No desktop CI.**
- **Cloud is LIVE** (worker + portal). Remaining external config is in `GO-LIVE.md` (OAuth secrets, Stripe live, portal domain).

---

## 2. Blockers to "sellable" (prioritized)

### A. Ship-engineering — _can we deliver a paid build at all?_
- **A1. Code signing** — `electron-builder` targets NSIS/DMG/AppImage but **nothing is signed**. Unsigned ⇒ Windows SmartScreen warnings + macOS Gatekeeper blocks the app on modern macOS. **Need:** Windows Authenticode (EV cert ideal), Apple Developer ID + **notarization**.
- **A2. Auto-update** — `electron-updater` is **not installed**; `publish` points at GitHub but there's no update plumbing. A shipped build is frozen. **Need:** electron-updater + a release feed (GitHub Releases or R2) + channels (alpha/beta/stable) + staged rollout + rollback.
- **A3. Desktop CI/CD** — no automated desktop build/sign/publish. **Need:** a workflow that on a version tag builds+signs+notarizes+publishes the installer, with ASAR-integrity + native-module checks.
- **A4. Green, committed baseline** — commit the ~74 files; fix the **4 pre-existing `cloud-identity` test tsc errors**; `pnpm node:rebuild` (app closed) so store/sqlite ABI tests run; resolve **`check:arch` (red: 83 files > 500 LOC hard cap)** — either consciously raise the cap or open a decomposition backlog (CI can't go green until this is decided); extend CI to desktop typecheck/test/build.

### B. Monetization loop — _does paying work + is it obvious?_
- **B1. Stripe LIVE** — set `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` + `STRIPE_PRO_PRICE_ID`/`STRIPE_TEAMS_PRICE_ID` (see `GO-LIVE.md §3`). Test the full loop in Stripe test mode first.
- **B2. In-app upgrade surface** — `UpgradeNotice` exists but isn't wired into the main flow. **Need:** "Upgrade to Pro" CTA in every Pro-only view (docs, backups, teams, SSH vault), in the account menu (show tier + Upgrade), and an onboarding feature tour. Today a free user never sees what Pro is.
- **B3. Post-purchase activation** — after Stripe checkout, entitlements only refresh on mount/explicit click. **Need:** `billing/success` → immediate `refresh()` + a "🎉 Pro is active" modal; re-fetch entitlements on app focus. (Without this: "did my payment work?" → chargebacks.)
- **B4. Public pricing page** — the `codestudio-landing` Pages site has no pricing/feature matrix. **Need:** tiers + per-seat price + "IDE free, cloud features Pro" messaging.

### C. Trust & compliance — _enterprise gate_
- **C1. Legal** — no ToS / Privacy / EULA / DPA; no footer links. GDPR export+delete **already exist** in `cloud-api` (`account.export`/`account.delete`) — surface them + publish the policies + a data-residency statement (Cloudflare US).
- **C2. Crash/error reporting** — none (no Sentry; the existing telemetry is admin-only). **Need:** client + worker error capture (Sentry or a Worker sink), a main-process `uncaughtException` hook, privacy-scrubbed (file paths ok, code contents never), opt-in.
- **C3. Support surface** — feedback form exists (manual, rate-limited) but no support email, help center, status page, or "report a bug → GitHub". **Need** all four.
- **C4. Secret hygiene** — `.env` holds `ZAI_API_KEY` + `MCP_INDEX_WORKER_TOKEN` in clear (gitignored, not in history, but **rotate before the repo ever goes public**). Cloud secrets are externalized correctly. The vault crypto is zero-knowledge + already adversarially reviewed; get an external pen-test before enterprise deals.

### D. Reliability / verification — _does it actually work for a customer?_
- **D1. E2E** — dozens of features are "build-verified, E2E-manual-pending" (the recurring memory phrase). **Need:** Playwright-electron smoke for the critical paths: OAuth login, cloud sync, SSH connect+SFTP, DB connect+query, billing checkout→activation.
- **D2. Native-module / ASAR verification** — `better-sqlite3`, `node-pty`, `ssh2`, `onnxruntime` must work **inside the packaged asar** (the recurring "ABI-gated" / "asar worker-spawn" risk). Verify on a real installed build per OS.
- **D3. Desktop licensing model (DECIDE)** — today **local** features (SSH vault UI, DB client, builder) are **not** tier-gated; entitlements are cached in localStorage with no TTL/signature → honor-system, bundle-patchable. This is **fine if** the model is "local free, cloud paid" (the SSH **vault sync** — the paid part — is already server-gated ✅). If you ever want to gate a *local* feature by tier, you need signed/TTL'd entitlement tokens + daily revalidation. **Pick one and document it.**

### E. Feature completion — _the paid surfaces must be whole_
- **SSH:** P7 (keygen/OpenSSH keys), P8 (in-app agent, auto-reconnect), live E2E (real sshd + Pro/Team accounts + multi-account team vault + ssh2-in-asar).
- **DB:** virtualized grid (@tanstack), history/saved-queries panel, indices/FK in the structure editor, P3 (master-password vault via `@mcp/vault-crypto`), P4 (mssql/mongo/redis bundled + Oracle lazy + streaming/export), **Electron runtime verification**. Decide if DB client stays free-local or becomes a paid tier.
- **Cloud:** P3 backups binary transport (client side), Enterprise (SSO/SCIM — design-partner-pulled).

---

## 3. Recommended next-session sequence

Each is roughly one focused session:

1. **Consolidate & go green** (A4) — commit the branch; fix the 4 tsc errors; ABI rebuild + full `pnpm test`; decide `check:arch`; widen CI to the desktop. _Exit: one green `typecheck`+`test`+`build:all`, committed._
2. **Cloud go-live** (B1 + `GO-LIVE.md`) — OAuth secrets, Stripe live, portal custom domain; verify billing loop in Stripe test → live.
3. **Monetization surface** (B2–B4) — in-app upgrade CTAs + post-purchase activation + pricing page.
4. **Distribution** (A1–A3) — code signing + notarization + electron-updater + tag-driven desktop release CI.
5. **Trust** (C1–C3) — legal pages + crash reporting + support/status; rotate dev secrets (C4).
6. **Verification** (D1–D2) — Playwright-electron critical-path E2E + per-OS packaged-build smoke.
7. **Feature completion** (E) — SSH P7/P8, DB P3/P4, backups client transport, as the paid surfaces mature.

> Sequencing logic: you can't sell what you can't ship (1,4) or get paid for (2,3); enterprises won't sign without trust (5); and you can't support it at scale without verification (6). Features (7) are the *last* gate, not the first — the product is already feature-rich.

---

## 4. Decisions needed from the owner (unblock the above)

- **Pricing numbers:** Pro $/mo, Teams $/seat/mo (plan suggested ~$10–12 Pro, ~$18–24/seat Teams — validate).
- **Licensing model:** "local free / cloud paid" (recommended; least friction, already enforced server-side) **vs** gate local features (needs signed entitlement tokens).
- **Signing assets:** do you have a Windows code-signing cert (EV?) + an Apple Developer account (for Developer ID + notarization)?
- **Crash-reporting choice:** Sentry SaaS vs self-host vs a custom Worker sink.
- **DB client tier:** free-local (like the API client) or a Pro feature?

---

## 5. Quick links
- External cloud config checklist: [`docs/cloud-api/GO-LIVE.md`](cloud-api/GO-LIVE.md)
- Worker: `https://codestudio-cloud-api.maiconspo6792.workers.dev` (D1 migrations 0001–0017 in prod)
- Portal: `https://codestudio-account-portal.pages.dev` (→ `account.codestudio.dev` once mapped)
- Requirements baseline (R1–R10) + the robust review outcome: see the memory `project_plans_individual_teams.md`.
