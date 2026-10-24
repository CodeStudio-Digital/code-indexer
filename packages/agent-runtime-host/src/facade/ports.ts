import type { AgentRunId } from '@mcp/agent-runtime-contracts';
import type { RuntimeRouteRecord } from '../router/types.js';
import type {
  AgentRunSnapshot,
  AttemptAuthority,
  AttemptStartFailure,
  CancelReason,
  CanonicalAgentEvent,
  EventCursor,
  InteractionResponse,
  ExecutableAgentAttempt,
  ResumeAgentCommand,
  StartAgentCommand,
} from './types.js';

export interface AgentControlPlanePort {
  prepareStart(command: StartAgentCommand): Promise<ExecutableAgentAttempt>;
  prepareResume(command: ResumeAgentCommand): Promise<ExecutableAgentAttempt>;
  commitAttemptStartFailure(failure: AttemptStartFailure): Promise<void>;
  commitCancelRequest(authority: AttemptAuthority, reason: CancelReason): Promise<void>;
  resolveInteraction(
    authority: AttemptAuthority,
    interactionId: string,
    response: InteractionResponse,
  ): Promise<void>;
  getSnapshot(agentRunId: AgentRunId): Promise<AgentRunSnapshot>;
  subscribeEvents(
    agentRunId: AgentRunId,
    cursor?: EventCursor,
  ): AsyncIterable<CanonicalAgentEvent>;
}

/**
 * Runtime-specific behavior ends at this port. Implementations must be
 * idempotent by attemptId and enforce the attempt fencing epoch.
 */
export interface AgentRuntimeAdapterPort {
  readonly generation: RuntimeRouteRecord['runtimeGeneration'];
  launch(prepared: ExecutableAgentAttempt, route: RuntimeRouteRecord): Promise<void>;
  cancel(authority: AttemptAuthority, reason: CancelReason): Promise<void>;
}
