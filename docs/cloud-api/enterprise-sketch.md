# Enterprise (P5) — design sketch

Enterprise is **design-partner-pulled**, not speculative. This is the concrete plan
for when a real org pulls for it; building SSO/SCIM/multi-squad before that is the
classic premature-enterprise mistake. The cheap, universally-correct foundation —
**org-scoped audit** — is already shipped (P5); everything below is sequenced for
when there's a signed design partner.

Entitlement substrate already in place: the tier ladder has `enterprise` with the
`sso` + `auditExport` feature flags (`packages/cloud-billing/src/domain/entitlements.ts`),
and `resolveOrgEntitlements` (`services/cloud-api/src/entitlements.ts`) gates per-org.
Enterprise is sold quote-based — NOT a self-serve Stripe price; an admin marks an org
`plan='enterprise'` out-of-band (manual D1 / an admin tool), so no public checkout.

## Done now (P5 foundation)
- **Org audit log** — `audit_log.org_id` column (mig `0014_audit_org`), `recordAudit`
  attributes org events, `GET /v1/orgs/:id/audit` (admin+, Team tier) returns recent
  activity (`listOrgAudit`). Enterprise layers **bulk/CSV export + longer retention**
  on top, gated by `auditExport` (see below).

## 1. Multi-squad (org → squads)
The local **company** feature (multi-agent squads/roles/kanban) becomes an org asset.
- `squads` table: `(id, org_id, name, template_id, created_at_ms)`; a squad is an
  org-scoped instance of a company template. `squad_members(squad_id, account_id, role)`
  subsets the org membership.
- Org-scoped company **templates** (review squad, migration squad) shared across squads:
  reuse the existing template store, add `org_id` scoping.
- Shared workspace (P4c org-sync) already scopes by org; squads get a sub-feed by adding
  `squad_id` to the org-sync key (or a `squad:` prefix on `client_doc_id`, mirroring the
  P2 workspace-prefix trick — no schema churn).
- Gating: `features.teamApis` for squads; nested squads/RBAC depth at `enterprise`.

## 2. SSO / SCIM
- **SSO (SAML/OIDC)**: an `org_sso_config` table `(org_id, provider, issuer, metadata_url,
  cert, domain)`; sign-in by org domain → IdP redirect → on callback, find/JIT-provision
  the account and add the org membership. Reuse the session issuer
  (`packages/cloud-identity/.../session-issuer.ts`) — only the *authentication* front-end
  is new; sessions/refresh are unchanged.
- **SCIM 2.0**: `/scim/v2/Users` + `/Groups` endpoints (bearer = a per-org SCIM token)
  → create/deactivate `org_members`. Maps group → role.
- Gating: `features.sso`. Hardest part is the per-IdP quirks — defer until a design
  partner names their IdP (Okta/Entra/Google), then implement that one first.

## 3. Audit export (Enterprise upsell over the Team activity log)
- `GET /v1/orgs/:id/audit/export?from=&to=` → streamed NDJSON/CSV of `audit_log` rows
  for the org (reuses the `org_id` column + index already added). Gated `auditExport`.
- **Retention**: Team keeps N days; Enterprise keeps unlimited + can request an archive
  to the org's own R2/S3 bucket (BYO-bucket, mirroring the P3 source-backup stance).

## 4. Data residency / region
- `organizations.region` (`us` | `eu`); route the org's D1/R2 to a regional binding.
  Cloudflare Jurisdictional Restrictions (D1/R2 EU) cover this — config, not app logic.
- Plumbed only when a partner requires it (e.g., EU data residency in the contract).

## 5. E2E team secret vault (deferred from P2)
- P2 deliberately shipped **structure-only** env sync (secrets stay per-device; the
  server never sees them). Enterprise can offer a true shared team secret vault:
  per-member-wrapped team key (envelope encryption), secrets encrypted client-side with
  the team key, the key wrapped to each member's device key. The real cost is **key
  rotation on member removal** + **device-loss recovery** — both need a partner's
  threat model before building. Until then, structure-only + the existing per-project
  local store remains the honest default.

## Sequencing (when pulled)
1. Audit export + retention (smallest; reuses P5 foundation).
2. SSO for the partner's specific IdP.
3. Multi-squad (org-scoped company templates + squad sub-feeds).
4. SCIM (after SSO).
5. Region + E2E secret vault (contract-driven).
