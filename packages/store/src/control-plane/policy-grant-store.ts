import type DatabaseConstructor from 'better-sqlite3';
import type {
  PolicyGrant,
  ResourceConstraint,
} from '@mcp/agent-runtime-contracts';
import { parseControlPlaneJson, stableControlPlaneJson } from './codec.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export interface PolicyGrantSeed {
  grantId: string;
  decisionId?: string;
  subject: PolicyGrant['subject'];
  capabilities: PolicyGrant['capabilities'];
  constraints: ResourceConstraint[];
  duration: PolicyGrant['duration'];
  binding?: unknown;
  effectiveInputHash?: string;
  policyVersion: string;
  nonce: string;
  createdAt?: string;
  expiresAt?: string;
}

export interface PersistedPolicyGrant {
  grantId: string;
  decisionId?: string;
  subject: PolicyGrant['subject'];
  capabilities: PolicyGrant['capabilities'];
  constraints: ResourceConstraint[];
  duration: PolicyGrant['duration'];
  effectiveInputHash?: string;
  policyVersion: string;
  nonce: string;
  consumptionStatus: 'unconsumed' | 'consumed' | 'revoked';
  consumedByToolUseId?: string;
  consumedAt?: string;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
}

interface GrantRow {
  grant_id: string;
  decision_id: string | null;
  subject_json: string;
  capabilities_json: string;
  constraints_json: string;
  duration: PolicyGrant['duration'];
  binding_json: string | null;
  effective_input_hash: string | null;
  policy_version: string;
  nonce: string;
  consumption_status: 'unconsumed' | 'consumed' | 'revoked';
  consumed_by_tool_use_id: string | null;
  consumed_at: string | null;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}

export type GrantConsumptionResult =
  | { kind: 'consumed'; grant: PersistedPolicyGrant }
  | { kind: 'already_consumed' }
  | { kind: 'revoked' }
  | { kind: 'expired' }
  | { kind: 'not_found' };

function hydrate(row: GrantRow): PersistedPolicyGrant {
  return {
    grantId: row.grant_id,
    decisionId: row.decision_id ?? undefined,
    subject: parseControlPlaneJson(row.subject_json, {} as PolicyGrant['subject']),
    capabilities: parseControlPlaneJson(row.capabilities_json, [] as PolicyGrant['capabilities']),
    constraints: parseControlPlaneJson(row.constraints_json, [] as ResourceConstraint[]),
    duration: row.duration,
    effectiveInputHash: row.effective_input_hash ?? undefined,
    policyVersion: row.policy_version,
    nonce: row.nonce,
    consumptionStatus: row.consumption_status,
    consumedByToolUseId: row.consumed_by_tool_use_id ?? undefined,
    consumedAt: row.consumed_at ?? undefined,
    createdAt: row.created_at,
    expiresAt: row.expires_at ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
  };
}

export class PolicyGrantStore {
  constructor(private readonly db: DB) {}

  issue(seed: PolicyGrantSeed): PersistedPolicyGrant {
    const createdAt = seed.createdAt ?? new Date().toISOString();
    this.db.prepare(`
      INSERT INTO policy_grants (
        grant_id, decision_id, subject_json, capabilities_json, constraints_json,
        duration, binding_json, effective_input_hash, policy_version, nonce,
        consumption_status, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unconsumed', ?, ?)
    `).run(
      seed.grantId,
      seed.decisionId ?? null,
      stableControlPlaneJson(seed.subject),
      stableControlPlaneJson(seed.capabilities),
      stableControlPlaneJson(seed.constraints),
      seed.duration,
      seed.binding !== undefined ? stableControlPlaneJson(seed.binding) : null,
      seed.effectiveInputHash ?? null,
      seed.policyVersion,
      seed.nonce,
      createdAt,
      seed.expiresAt ?? null,
    );
    return this.get(seed.grantId)!;
  }

  get(grantId: string): PersistedPolicyGrant | null {
    const row = this.db.prepare('SELECT * FROM policy_grants WHERE grant_id = ?').get(grantId) as GrantRow | undefined;
    return row ? hydrate(row) : null;
  }

  /**
   * Compare-and-set consumption of a `once` grant. Exactly one caller can win
   * even under concurrency: the UPDATE only fires when the row is still
   * `unconsumed` for the given nonce. Expiry and revocation short-circuit
   * before the CAS so a stale replay never executes.
   */
  consumeOnce(
    grantId: string,
    nonce: string,
    toolUseId: string,
    at = new Date().toISOString(),
  ): GrantConsumptionResult {
    const current = this.get(grantId);
    if (!current) return { kind: 'not_found' };
    if (current.consumptionStatus === 'revoked') return { kind: 'revoked' };
    if (current.consumptionStatus === 'consumed') return { kind: 'already_consumed' };
    if (current.expiresAt && Date.parse(current.expiresAt) <= Date.parse(at)) return { kind: 'expired' };

    const result = this.db.prepare(`
      UPDATE policy_grants
        SET consumption_status = 'consumed', consumed_by_tool_use_id = ?, consumed_at = ?
        WHERE grant_id = ? AND nonce = ? AND consumption_status = 'unconsumed'
    `).run(toolUseId, at, grantId, nonce);
    if (result.changes !== 1) return { kind: 'already_consumed' };
    return { kind: 'consumed', grant: this.get(grantId)! };
  }

  revoke(grantId: string, at = new Date().toISOString()): boolean {
    const result = this.db.prepare(`
      UPDATE policy_grants
        SET consumption_status = 'revoked', revoked_at = ?
        WHERE grant_id = ? AND consumption_status <> 'consumed'
    `).run(at, grantId);
    return result.changes === 1;
  }
}
