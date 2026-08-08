/** Versioned, serializable code-run policy. It never contains secret values. */
export type RuntimePolicySourceV1 =
  | 'product_default'
  | 'deployment'
  | 'operator'
  | 'preset'
  | 'request'
  | 'clamp';

export type RuntimePolicyScalarV1 = string | number | boolean | null;

export interface ResolvedFieldProvenanceV1 {
  path: string;
  value: RuntimePolicyScalarV1 | readonly string[];
  source: RuntimePolicySourceV1;
  sourceRevision: string;
  clampedBy?: string;
}

export interface ProviderRuntimePolicyV1 {
  firstByteTimeoutMs: number;
  idleTimeoutMs: number;
  thinkingOnlyTimeoutMs: number;
  transientRetriesPerTurn: number;
  transientRetriesPerRun: number;
  streamHeartbeatMs: number;
}

export interface ContextRuntimePolicyV1 {
  toolResultChars: number;
  subagentToolResultChars: number;
  unrestrictedToolResultChars: number;
  unrestrictedSubagentToolResultChars: number;
  turnBudgetChars: number;
  interventionCooldownTurns: number;
  compactionProfile: 'balanced';
}

export interface CapabilityProjectionPolicyV1 {
  profile: 'auto' | 'bootstrap' | 'navigate' | 'full';
  visibleToolCap: number;
  disabledCapabilityNames: readonly string[];
}

export interface ExecutionBudgetPolicyV1 {
  maxTurns: number | null;
  maxWallMs: number | null;
  maxToolCalls: number | null;
  cancellation: 'cooperative_then_kill';
}

export interface SubagentRuntimePolicyV1 {
  enabled: boolean;
  maxParallel: number;
  maxDepth: number;
}

export interface HostResourcePolicyV1 {
  codeExecPreset: 'bounded' | 'elevated';
  workerHeapMb: number;
  workerIdleTtlMs: number;
  workerPostRunLingerMs: number;
}

export interface DiagnosticsRuntimePolicyV1 {
  traceLevel: 'off' | 'error' | 'verbose';
  redactSensitiveValues: true;
  sampleRate: number;
}

export interface RuntimePolicyValuesV1 {
  productPreset: string;
  provider: ProviderRuntimePolicyV1;
  context: ContextRuntimePolicyV1;
  capabilities: CapabilityProjectionPolicyV1;
  execution: ExecutionBudgetPolicyV1;
  subagents: SubagentRuntimePolicyV1;
  host: HostResourcePolicyV1;
  diagnostics: DiagnosticsRuntimePolicyV1;
}

export type RuntimePolicyPatchV1 = {
  [K in keyof RuntimePolicyValuesV1]?: RuntimePolicyValuesV1[K] extends object
    ? Partial<RuntimePolicyValuesV1[K]>
    : RuntimePolicyValuesV1[K];
};

export interface RuntimePolicyLayerV1 {
  revision: string;
  values: RuntimePolicyPatchV1;
}

export interface RuntimePolicyClampV1 {
  path: string;
  clampId: string;
  revision: string;
  min?: number;
  max?: number;
}

export interface ResolveRuntimePolicyInputV1 {
  deployment?: RuntimePolicyLayerV1;
  operator?: RuntimePolicyLayerV1;
  preset?: RuntimePolicyLayerV1;
  request?: RuntimePolicyLayerV1;
  clamps?: readonly RuntimePolicyClampV1[];
  resolvedAt?: string;
}

export interface ResolvedRuntimePolicyV1 extends RuntimePolicyValuesV1 {
  schemaVersion: 1;
  policyId: string;
  policyDigest: string;
  resolvedAt: string;
  provenance: readonly ResolvedFieldProvenanceV1[];
}
