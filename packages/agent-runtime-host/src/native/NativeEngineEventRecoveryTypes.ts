import type { agentV1Common } from '@mcp/agent-runtime-contracts';

export interface UnresolvedCapabilityDispatch {
  readonly identity: agentV1Common.AttemptIdentity;
  readonly runtimeInstanceId: string;
  readonly operationId: string;
  readonly toolUseId: string;
  readonly grantId: string;
  readonly effectiveInputSha256: Uint8Array;
  readonly startedAtUnixMs: bigint;
  readonly journalSequence: bigint;
  readonly journalCommitSha256: Uint8Array;
  /** A durable terminal with unknown effects is still unresolved. */
  readonly outcomeUnknownReason?: string;
}
