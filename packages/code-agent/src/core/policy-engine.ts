/**
 * Policy Engine — shadow evaluation (Fase 2 — 2B).
 *
 * Aggregates the existing decision sources into a single ordered PolicyDecision
 * (doc 14 §10 precedence) and compares it, in the allow-vs-block dimension,
 * against the legacy gate result. Runs in shadow only: it records what it WOULD
 * decide, never blocking the invocation, until a later human gate flips
 * enforcement.
 *
 * Precedence (highest wins; a higher `deny` is irreducible):
 *   1. hard system safety
 *   2. managed organization deny
 *   3. session / plan / spec / task scope
 *   4. workspace lease / resource constraints
 *   5. project policy
 *   6. explicit user grant
 *   7. decision hook
 *   8. default preset
 *
 * The legacy `PermissionGate.check` returns `{allowed}` — it collapses deny and
 * ask into a single "block". So the shadow↔legacy comparison is measured in the
 * allow-vs-block dimension; the deny/ask distinction is validated internally by
 * precedence tests.
 */
import { randomUUID } from 'node:crypto';
import type {
  PolicyDecision as ContractPolicyDecision,
  PolicyEffect,
  ResourceConstraint,
} from '@mcp/agent-runtime-contracts';
import type { CoderTool } from './tool.js';
import {
  evaluateToolInvocation,
  type PolicyContext,
  type PolicyDecision as LegacyPolicyDecision,
} from './policy.js';
import { shadowToLegacyDimension, type LegacyEffect } from '@mcp/store/control-plane/policy-decision-store.js';

export type PolicySourceType =
  | 'system'
  | 'organization'
  | 'session'
  | 'workspace_lease'
  | 'project'
  | 'grant'
  | 'hook'
  | 'default';

/** Precedence rank — lower number wins; a lower-ranked deny is irreducible. */
const SOURCE_RANK: Record<PolicySourceType, number> = {
  system: 1,
  organization: 2,
  session: 3,
  workspace_lease: 4,
  project: 5,
  grant: 6,
  hook: 7,
  default: 8,
};

export interface PolicySourceVote {
  sourceType: PolicySourceType;
  sourceRef: string;
  outcome: 'allow' | 'deny' | 'ask' | 'abstain';
  reasonCode?: string;
  constraints?: ResourceConstraint[];
}

export interface PolicyEvaluationRequest {
  tool: CoderTool;
  capabilityId: string;
  capabilityVersion: string;
  args: Record<string, unknown>;
  legacyContext: PolicyContext;
  /** True for a background (non-interactive) run — `ask` becomes structured deny. */
  background: boolean;
  policyVersion?: string;
  /** Extra source votes (decision hooks, org policy, grants). Observation hooks MUST NOT appear here. */
  extraVotes?: PolicySourceVote[];
  effectiveInputHash?: string;
  toolUseId?: string;
  sessionId?: string;
  commandId?: string;
  agentRunId?: string;
}

export interface PolicyComparison {
  legacyEffect: LegacyEffect;
  shadowEffect: PolicyEffect;
  agreement: boolean;
}

export interface PolicyEvaluationResult {
  decision: ContractPolicyDecision;
  legacyResult: LegacyPolicyDecision;
  comparison: PolicyComparison;
  votes: PolicySourceVote[];
}

/** Maps the legacy per-mode block reason into a source vote. */
function legacyToVote(legacy: LegacyPolicyDecision): PolicySourceVote {
  if (legacy.allowed) {
    return { sourceType: 'session', sourceRef: 'core/policy.ts', outcome: 'abstain' };
  }
  // plan_mode / spec_mode / task_scope / sandbox_required / admin_required all
  // sit in the session/plan/spec/task precedence band.
  return {
    sourceType: 'session',
    sourceRef: `core/policy.ts:${legacy.reason}`,
    outcome: 'deny',
    reasonCode: legacy.reason,
  };
}

/**
 * Resolves the winning effect from all votes under precedence. A `deny` at any
 * rank is irreducible: once denied at rank N, no lower-precedence (higher rank
 * number) allow can override it. `ask` only wins if nothing denied above it.
 */
function resolveEffect(votes: PolicySourceVote[]): {
  effect: PolicyEffect;
  reasonCode: string;
  precedence: number;
  winning: PolicySourceVote;
} {
  const ranked = [...votes]
    .filter((v) => v.outcome !== 'abstain')
    .sort((a, b) => SOURCE_RANK[a.sourceType] - SOURCE_RANK[b.sourceType]);

  // First deny in precedence order is the final effect.
  const firstDeny = ranked.find((v) => v.outcome === 'deny');
  if (firstDeny) {
    return {
      effect: 'deny',
      reasonCode: firstDeny.reasonCode ?? `deny:${firstDeny.sourceType}`,
      precedence: SOURCE_RANK[firstDeny.sourceType],
      winning: firstDeny,
    };
  }
  const firstAsk = ranked.find((v) => v.outcome === 'ask');
  if (firstAsk) {
    return {
      effect: 'ask',
      reasonCode: firstAsk.reasonCode ?? `ask:${firstAsk.sourceType}`,
      precedence: SOURCE_RANK[firstAsk.sourceType],
      winning: firstAsk,
    };
  }
  const firstAllow = ranked.find((v) => v.outcome === 'allow');
  if (firstAllow) {
    return {
      effect: 'allow',
      reasonCode: firstAllow.reasonCode ?? `allow:${firstAllow.sourceType}`,
      precedence: SOURCE_RANK[firstAllow.sourceType],
      winning: firstAllow,
    };
  }
  return {
    effect: 'allow',
    reasonCode: 'default_allow',
    precedence: SOURCE_RANK.default,
    winning: { sourceType: 'default', sourceRef: 'default-preset', outcome: 'allow' },
  };
}

export function evaluatePolicyShadow(request: PolicyEvaluationRequest): PolicyEvaluationResult {
  const legacyResult = evaluateToolInvocation(request.tool, request.args, request.legacyContext);
  const votes: PolicySourceVote[] = [
    legacyToVote(legacyResult),
    ...(request.extraVotes ?? []),
  ];

  const resolved = resolveEffect(votes);
  let effect = resolved.effect;
  let reasonCode = resolved.reasonCode;

  // Background runs cannot pause for an interactive ask: it becomes a
  // structured deny (14:727).
  if (effect === 'ask' && request.background) {
    effect = 'deny';
    reasonCode = 'background_ask_denied';
  }

  const decision: ContractPolicyDecision = {
    decisionId: `decision:${randomUUID()}`,
    effect,
    reasonCode,
    explanation: `resolved at precedence ${resolved.precedence} from ${resolved.winning.sourceType}`,
    precedence: resolved.precedence,
    sources: votes.map((v) => ({
      sourceType: v.sourceType === 'workspace_lease' ? 'session' : v.sourceType === 'default' ? 'system' : v.sourceType,
      sourceRef: v.sourceRef,
      outcome: v.outcome,
    })),
    constraints: votes.flatMap((v) => v.constraints ?? []),
    requiresReevaluation: false,
    audit: {
      capabilityId: request.capabilityId as never,
      capabilityVersion: request.capabilityVersion,
      policyVersion: request.policyVersion ?? 'policy-shadow-v1',
      decidedAt: new Date().toISOString(),
    },
  };

  const legacyEffect: LegacyEffect = legacyResult.allowed ? 'allow' : 'block';
  const shadowEffect = effect;
  const comparison: PolicyComparison = {
    legacyEffect,
    shadowEffect,
    agreement: shadowToLegacyDimension(shadowEffect) === legacyEffect,
  };

  return { decision, legacyResult, comparison, votes };
}
