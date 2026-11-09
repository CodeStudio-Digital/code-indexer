import { createHash } from 'node:crypto';
import type { CompanySessionIdentity } from '@mcp/company-contracts';

export function companyConfigRevision(configJson: string): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
  let serialized = configJson;
  try { serialized = JSON.stringify(canonical(JSON.parse(configJson))); } catch { /* Preserve legacy invalid config identity. */ }
  return createHash('sha256').update(serialized).digest('hex');
}

/** Additive migration: existing IDs, URLs and bundle ownership remain valid. */
export function companySessionIdentity(session: { id: string; parent_session_id: string | null; config_json: string }, origin?: unknown): CompanySessionIdentity {
  const original = origin && typeof origin === 'object' ? origin as Record<string, unknown> : {};
  return {
    company_id: session.parent_session_id ?? session.id,
    session_id: session.id,
    scope: { workspace: 'shared', resources: 'company', conversation: 'session', write_policy: 'serialized_mutations' },
    configuration: {
      mode: 'snapshot', revision: companyConfigRevision(session.config_json),
      inherited_from: session.parent_session_id,
      inherited_revision: typeof original.revision === 'string' ? original.revision : null,
    },
  };
}
