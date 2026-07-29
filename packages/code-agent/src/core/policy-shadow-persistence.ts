import type {
  CapabilityDescriptor,
  PolicyDecision,
  PolicyEffect,
  ResolvedCapabilitySet,
} from '@mcp/agent-runtime-contracts';
import type { SessionId } from '@mcp/session-storage';

/** Legacy permission gate collapses deny/ask into one blocked outcome. */
export type LegacyPolicyEffect = 'allow' | 'block';

export interface PolicyShadowDecisionWrite {
  sessionId: SessionId;
  agentRunId: string;
  toolUseId: string;
  capabilityId: string;
  capabilityVersion: string;
  policyVersion: string;
  background: boolean;
  decision: PolicyDecision;
}

export interface PolicyShadowComparisonWrite {
  sessionId: SessionId;
  agentRunId: string;
  comparisonId: string;
  decisionId: string;
  capabilityId: string;
  toolUseId: string;
  legacyEffect: LegacyPolicyEffect;
  shadowEffect: PolicyEffect;
  comparedAt: string;
  evaluationMs: number;
}

export interface PolicyShadowCapabilitySetWrite {
  sessionId: SessionId;
  agentRunId: string;
  set: ResolvedCapabilitySet;
  descriptors: readonly CapabilityDescriptor[];
}

/**
 * Host-owned durability boundary for policy shadow state. The policy engine
 * knows neither SQLite nor bundle paths; a host must inject one authority.
 */
export interface PolicyShadowPersistencePort {
  recordDecision(input: PolicyShadowDecisionWrite): Promise<void>;
  recordComparison(input: PolicyShadowComparisonWrite): Promise<void>;
  recordCapabilitySet(input: PolicyShadowCapabilitySetWrite): Promise<void>;
}

export interface PolicyComparisonClassification {
  agreement: boolean;
  divergenceKind: string | null;
  critical: boolean;
}

export function shadowToLegacyDimension(
  effect: PolicyEffect,
): LegacyPolicyEffect {
  return effect === 'allow' ? 'allow' : 'block';
}

export function classifyPolicyComparison(
  legacyEffect: LegacyPolicyEffect,
  shadowEffect: PolicyEffect,
): PolicyComparisonClassification {
  if (shadowToLegacyDimension(shadowEffect) === legacyEffect) {
    return { agreement: true, divergenceKind: null, critical: false };
  }
  if (legacyEffect === 'allow' && shadowEffect === 'deny') {
    return {
      agreement: false,
      divergenceKind: 'shadow_denies_legacy_allow',
      critical: true,
    };
  }
  if (legacyEffect === 'allow' && shadowEffect === 'ask') {
    return {
      agreement: false,
      divergenceKind: 'shadow_asks_legacy_allow',
      critical: false,
    };
  }
  return {
    agreement: false,
    divergenceKind: 'shadow_allows_legacy_block',
    critical: true,
  };
}
