import type { CapabilityDescriptor, ResolvedCapabilitySet } from './capabilities.js';
import type { AgentRunId, SessionId } from './ids.js';
import type { ExecutionEnvironmentKind } from './environment.js';
import type { ResolvedRuntimePolicyV1 } from './runtime-configuration.js';

/** Resolved by the worker after tool registration, before the first provider turn.
 * No credentials, environment values, conversation text or tool arguments belong here. */
export interface CoderAttemptPreparationV1 {
  schemaVersion: 1;
  sessionId: SessionId;
  agentRunId: AgentRunId;
  runnerRunId: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
  agentDefinitionId: string;
  systemPromptSha256: string;
  capabilityProfile: string;
  capabilitySet: ResolvedCapabilitySet;
  capabilityDescriptors: CapabilityDescriptor[];
  environment: { kind: ExecutionEnvironmentKind; cwd: string };
  policy: {
    permissionMode: string;
    planMode: boolean;
    specMode: boolean;
    runtime?: ResolvedRuntimePolicyV1;
  };
}

/** Receipt from the owning host, not a worker preference or an engine switch. */
export interface CoderAttemptAdmissionV1 {
  schemaVersion: 1;
  sessionId: SessionId;
  agentRunId: AgentRunId;
  attemptId: string;
  executorOwnerId: string;
  fencingEpoch: number;
  preparationSha256: string;
  preparationRef: string;
  runtimeGeneration: 'legacy_ts';
}
