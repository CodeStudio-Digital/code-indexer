import type DatabaseConstructor from 'better-sqlite3';
import type {
  PolicyDecision,
  PolicyEffect,
  ResourceConstraint,
} from '@mcp/agent-runtime-contracts';
import { parseControlPlaneJson, stableControlPlaneJson } from './codec.js';

type DB = InstanceType<typeof DatabaseConstructor>;

/** Legacy gate result collapses deny/ask into 'block' (allowed:false). */
export type LegacyEffect = 'allow' | 'block';

export interface PolicyDecisionSeed {
  decision: PolicyDecision;
  sessionId?: string;
  legacySessionId?: number;
  commandId?: string;
  agentRunId?: string;
  toolUseId?: string;
  capabilityId: string;
  capabilityVersion: string;
  effectiveInputHash?: string;
  policyVersion: string;
  background: boolean;
  decidedAt?: string;
}

export interface DecisionComparisonSeed {
  comparisonId: string;
  decisionId: string;
  sessionId?: string;
  capabilityId: string;
  toolUseId?: string;
  legacyEffect: LegacyEffect;
  shadowEffect: PolicyEffect;
  detail?: string;
  comparedAt?: string;
  /** Shadow evaluation wall time in ms (durable — feeds the admin percentiles). */
  evaluationMs?: number;
}

export interface PolicyComparisonRecord {
  comparisonId: string;
  decisionId: string;
  capabilityId: string;
  legacyEffect: LegacyEffect;
  shadowEffect: PolicyEffect;
  agreement: boolean;
  divergenceKind?: string;
  critical: boolean;
  detail?: string;
  comparedAt: string;
  evaluationMs?: number;
}

interface ComparisonRow {
  comparison_id: string;
  decision_id: string;
  capability_id: string;
  legacy_effect: LegacyEffect;
  shadow_effect: PolicyEffect;
  agreement: number;
  divergence_kind: string | null;
  critical: number;
  detail: string | null;
  compared_at: string;
  evaluation_ms: number | null;
}

/**
 * Maps a shadow PolicyEffect to the legacy allow-vs-block dimension: the
 * legacy gate cannot distinguish deny from ask, so both fold into 'block'.
 */
export function shadowToLegacyDimension(effect: PolicyEffect): LegacyEffect {
  return effect === 'allow' ? 'allow' : 'block';
}

/**
 * Classifies a divergence. A shadow 'deny' where the legacy path allowed is
 * the critical case (shadow would have blocked a real allow).
 */
function classifyDivergence(
  legacy: LegacyEffect,
  shadow: PolicyEffect,
): { agreement: boolean; divergenceKind?: string; critical: boolean } {
  const shadowDim = shadowToLegacyDimension(shadow);
  if (shadowDim === legacy) return { agreement: true, critical: false };
  if (legacy === 'allow' && shadow === 'deny') {
    return { agreement: false, divergenceKind: 'shadow_denies_legacy_allow', critical: true };
  }
  if (legacy === 'allow' && shadow === 'ask') {
    return { agreement: false, divergenceKind: 'shadow_asks_legacy_allow', critical: false };
  }
  return { agreement: false, divergenceKind: 'shadow_allows_legacy_block', critical: true };
}

function hydrateComparison(row: ComparisonRow): PolicyComparisonRecord {
  return {
    comparisonId: row.comparison_id,
    decisionId: row.decision_id,
    capabilityId: row.capability_id,
    legacyEffect: row.legacy_effect,
    shadowEffect: row.shadow_effect,
    agreement: row.agreement === 1,
    divergenceKind: row.divergence_kind ?? undefined,
    critical: row.critical === 1,
    detail: row.detail ?? undefined,
    comparedAt: row.compared_at,
    evaluationMs: row.evaluation_ms ?? undefined,
  };
}

export class PolicyDecisionStore {
  constructor(private readonly db: DB) {}

  record(seed: PolicyDecisionSeed): void {
    const d = seed.decision;
    const constraints: ResourceConstraint[] = d.constraints ?? [];
    this.db.prepare(`
      INSERT OR IGNORE INTO policy_decisions (
        decision_id, session_id, legacy_session_id, command_id, agent_run_id,
        tool_use_id, capability_id, capability_version, effect, reason_code,
        explanation, precedence, sources_json, constraints_json,
        requires_reevaluation, effective_input_hash, policy_version, background,
        audit_json, decided_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      d.decisionId,
      seed.sessionId ?? null,
      seed.legacySessionId ?? null,
      seed.commandId ?? null,
      seed.agentRunId ?? null,
      seed.toolUseId ?? null,
      seed.capabilityId,
      seed.capabilityVersion,
      d.effect,
      d.reasonCode,
      d.explanation ?? null,
      d.precedence ?? 0,
      stableControlPlaneJson(d.sources ?? []),
      stableControlPlaneJson(constraints),
      d.requiresReevaluation ? 1 : 0,
      seed.effectiveInputHash ?? null,
      seed.policyVersion,
      seed.background ? 1 : 0,
      stableControlPlaneJson(d.audit ?? {}),
      seed.decidedAt ?? d.audit?.decidedAt ?? new Date().toISOString(),
    );
  }

  recordComparison(seed: DecisionComparisonSeed): PolicyComparisonRecord {
    const { agreement, divergenceKind, critical } = classifyDivergence(seed.legacyEffect, seed.shadowEffect);
    const comparedAt = seed.comparedAt ?? new Date().toISOString();
    this.db.prepare(`
      INSERT OR IGNORE INTO policy_decision_comparisons (
        comparison_id, decision_id, session_id, capability_id, tool_use_id,
        legacy_effect, shadow_effect, agreement, divergence_kind, critical,
        detail, compared_at, evaluation_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      seed.comparisonId,
      seed.decisionId,
      seed.sessionId ?? null,
      seed.capabilityId,
      seed.toolUseId ?? null,
      seed.legacyEffect,
      seed.shadowEffect,
      agreement ? 1 : 0,
      divergenceKind ?? null,
      critical ? 1 : 0,
      seed.detail ?? null,
      comparedAt,
      seed.evaluationMs ?? null,
    );
    return {
      comparisonId: seed.comparisonId,
      decisionId: seed.decisionId,
      capabilityId: seed.capabilityId,
      legacyEffect: seed.legacyEffect,
      shadowEffect: seed.shadowEffect,
      agreement,
      divergenceKind,
      critical,
      detail: seed.detail,
      comparedAt,
      evaluationMs: seed.evaluationMs,
    };
  }

  listComparisons(limit = 100): PolicyComparisonRecord[] {
    const safeLimit = Math.max(1, Math.min(10_000, Math.floor(limit)));
    return (this.db.prepare(`
      SELECT * FROM policy_decision_comparisons ORDER BY compared_at DESC LIMIT ?
    `).all(safeLimit) as ComparisonRow[]).map(hydrateComparison);
  }

  agreementStats(): { total: number; agreements: number; critical: number } {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS total,
        COALESCE(SUM(agreement), 0) AS agreements,
        COALESCE(SUM(critical), 0) AS critical
      FROM policy_decision_comparisons
    `).get() as { total: number; agreements: number; critical: number };
    return row;
  }
}
