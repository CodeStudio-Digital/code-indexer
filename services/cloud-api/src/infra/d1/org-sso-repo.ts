/** Per-org OIDC SSO config (org_sso_config). The client secret is stored encrypted
 *  (client_secret_enc); this repo is storage-only — encryption/decryption happens in
 *  the route via secret-cipher so the key never leaves the request scope. */
import type { DbExecutor } from '@cloudstudio/cloud-kernel';

export interface OrgSsoConfig {
  orgId: string;
  issuer: string;
  clientId: string;
  clientSecretEnc: string;
  allowedDomains: string[];
  enabled: boolean;
}

interface Row {
  org_id: string;
  issuer: string;
  client_id: string;
  client_secret_enc: string;
  allowed_domains: string;
  enabled: number;
}

const toConfig = (r: Row): OrgSsoConfig => ({
  orgId: r.org_id,
  issuer: r.issuer,
  clientId: r.client_id,
  clientSecretEnc: r.client_secret_enc,
  allowedDomains: r.allowed_domains.split(',').map((d) => d.trim()).filter(Boolean),
  enabled: r.enabled === 1,
});

export interface OrgSsoRepo {
  get(orgId: string): Promise<OrgSsoConfig | null>;
  upsert(cfg: OrgSsoConfig & { nowMs: number }): Promise<void>;
}

export function createOrgSsoRepo(db: DbExecutor): OrgSsoRepo {
  return {
    async get(orgId) {
      const r = await db.first<Row>(
        'SELECT org_id, issuer, client_id, client_secret_enc, allowed_domains, enabled FROM org_sso_config WHERE org_id = ?',
        [orgId],
      );
      return r ? toConfig(r) : null;
    },
    async upsert(cfg) {
      await db.run(
        `INSERT INTO org_sso_config (org_id, issuer, client_id, client_secret_enc, allowed_domains, enabled, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(org_id) DO UPDATE SET
           issuer = excluded.issuer, client_id = excluded.client_id,
           client_secret_enc = excluded.client_secret_enc, allowed_domains = excluded.allowed_domains,
           enabled = excluded.enabled, updated_at_ms = excluded.updated_at_ms`,
        [
          cfg.orgId,
          cfg.issuer,
          cfg.clientId,
          cfg.clientSecretEnc,
          cfg.allowedDomains.join(','),
          cfg.enabled ? 1 : 0,
          cfg.nowMs,
          cfg.nowMs,
        ],
      );
    },
  };
}
