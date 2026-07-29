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
  PreparedAgentAttempt,
  ResumeAgentCommand,
  StartAgentCommand,
} from './types.js';

export interface AgentControlPlanePort {
  prepareStart(command: StartAgentCommand): Promise<PreparedAgentAttempt>;
  prepareResume(command: ResumeAgentCommand): Promise<PreparedAgentAttempt>;
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
  launch(prepared: PreparedAgentAttempt, route: RuntimeRouteRecord): Promise<void>;
  cancel(authority: AttemptAuthority, reason: CancelReason): Promise<void>;
}
