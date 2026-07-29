import type {
  AgentRunAttemptId,
  AgentRunId,
  ExecutionEnvironmentKind,
  SessionId,
} from '@mcp/agent-runtime-contracts';

export type AgentRuntimeGeneration = 'legacy_ts' | 'rust_v1';

export type RuntimePreference =
  | 'legacy_required'
  | 'rust_preferred'
  | 'rust_required';

export type RuntimeIneligibilityReasonCode =
  | 'rust_disabled'
  | 'invalid_eligibility_input'
  | 'surface_unsupported'
  | 'platform_unsupported'
  | 'environment_unsupported'
  | 'provider_unsupported'
  | 'capability_profile_unsupported'
  | 'capability_catalog_unsupported'
  | 'capability_unsupported'
  | 'engine_version_unsupported'
  | 'build_id_unsupported'
  | 'binary_digest_mismatch'
  | 'protocol_version_unsupported'
  | 'containment_level_unsupported'
  | 'eligibility_check_failed'
  | 'eligibility_result_invalid';

export type RequiredContainmentLevel =
  | 'hard_aggregate'
  | 'hard_process'
  | 'monitored';

export interface RuntimeIneligibilityReason {
  code: RuntimeIneligibilityReasonCode;
  dimension: string;
  requested?: string;
  detail?: string;
}

export interface RuntimeEligibilityInput {
  surface: string;
  platform: string;
  environmentKind: ExecutionEnvironmentKind;
  provider: string;
  capabilityProfile: string;
  capabilityCatalogVersion: string;
  capabilityIds: readonly string[];
  engineVersion: string;
  runtimeBuildId: string;
  runtimeBinarySha256: string;
  protocolVersion: string;
  requiredContainmentLevel: RequiredContainmentLevel;
}

export interface RuntimeEligibilityDecision {
  eligible: boolean;
  reasons: readonly RuntimeIneligibilityReason[];
}

export interface RuntimeRouteRequest {
  sessionId: SessionId;
  agentRunId: AgentRunId;
  attemptId: AgentRunAttemptId;
  preference: RuntimePreference;
  cohort: string;
  eligibility: RuntimeEligibilityInput;
}

export type RuntimeSelectionReasonCode =
  | 'legacy_required'
  | 'rust_eligible'
  | 'rust_ineligible';

export interface RuntimeRouteRecord {
  schemaVersion: 1;
  sessionId: SessionId;
  agentRunId: AgentRunId;
  attemptId: AgentRunAttemptId;
  runtimeGeneration: AgentRuntimeGeneration;
  preference: RuntimePreference;
  selectionReasonCode: RuntimeSelectionReasonCode;
  ineligibilityReasons: readonly RuntimeIneligibilityReason[];
  surface: string;
  platform: string;
  environmentKind: ExecutionEnvironmentKind;
  provider: string;
  capabilityProfile: string;
  capabilityCatalogVersion: string;
  capabilityIds: readonly string[];
  engineVersion: string;
  runtimeBuildId: string;
  runtimeBinarySha256: string;
  protocolVersion: string;
  requiredContainmentLevel: RequiredContainmentLevel;
  cohort: string;
  selectedAt: string;
}

export interface RuntimeRouteCommit {
  record: RuntimeRouteRecord;
  inserted: boolean;
}
