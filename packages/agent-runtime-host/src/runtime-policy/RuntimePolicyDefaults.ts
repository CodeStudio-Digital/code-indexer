import type { RuntimePolicyValuesV1 } from '@mcp/agent-runtime-contracts';

export const RUNTIME_POLICY_DEFAULT_REVISION = 'code-run-defaults-v1';

export const DEFAULT_RUNTIME_POLICY_V1: Readonly<RuntimePolicyValuesV1> = Object.freeze({
  productPreset: 'balanced',
  provider: Object.freeze({
    firstByteTimeoutMs: 240_000,
    idleTimeoutMs: 90_000,
    thinkingOnlyTimeoutMs: 240_000,
    transientRetriesPerTurn: 3,
    transientRetriesPerRun: 30,
    streamHeartbeatMs: 10_000,
  }),
  context: Object.freeze({
    toolResultChars: 24_000,
    subagentToolResultChars: 12_000,
    unrestrictedToolResultChars: 1_000_000,
    unrestrictedSubagentToolResultChars: 500_000,
    turnBudgetChars: 30_000,
    interventionCooldownTurns: 5,
    compactionProfile: 'balanced',
  }),
  capabilities: Object.freeze({
    profile: 'auto',
    visibleToolCap: 28,
    disabledCapabilityNames: Object.freeze([]),
  }),
  execution: Object.freeze({
    maxTurns: null,
    maxWallMs: null,
    maxToolCalls: null,
    cancellation: 'cooperative_then_kill',
  }),
  subagents: Object.freeze({
    enabled: true,
    maxParallel: 4,
    maxDepth: 4,
  }),
  host: Object.freeze({
    codeExecPreset: 'bounded',
    workerHeapMb: 1_024,
    workerIdleTtlMs: 300_000,
    workerPostRunLingerMs: 30_000,
  }),
  diagnostics: Object.freeze({
    traceLevel: 'off',
    redactSensitiveValues: true,
    sampleRate: 0,
  }),
});
