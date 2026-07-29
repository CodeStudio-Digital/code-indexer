import type {
  AgentRunId,
} from '@mcp/agent-runtime-contracts';
import { AgentRuntimeHostError } from '../errors.js';
import type {
  AgentRunHandleContext,
  AttemptAuthority,
  AgentRunSnapshot,
  CancelReason,
  CanonicalAgentEvent,
  EventCursor,
  InteractionResponse,
} from './types.js';

export interface AgentRunHandleDelegate {
  cancel(authority: AttemptAuthority, reason: CancelReason): Promise<void>;
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

export interface AgentRunHandleApi
  extends Omit<AgentRunHandleContext, 'authority'> {
  cancel(reason: CancelReason): Promise<void>;
  resolveInteraction(interactionId: string, response: InteractionResponse): Promise<void>;
  getSnapshot(): Promise<AgentRunSnapshot>;
  subscribeEvents(cursor?: EventCursor): AsyncIterable<CanonicalAgentEvent>;
  dispose(): void;
}

/**
 * A lightweight host handle. Disposing it only releases the caller's handle;
 * it never cancels or otherwise changes the durable AgentRun.
 */
export class AgentRunHandle implements AgentRunHandleApi {
  readonly agentRunId: AgentRunId;
  readonly attemptId: AgentRunHandleContext['attemptId'];
  readonly runtimeGeneration: AgentRunHandleContext['runtimeGeneration'];
  private readonly authority: AttemptAuthority;
  private disposed = false;

  constructor(
    context: AgentRunHandleContext,
    private readonly delegate: AgentRunHandleDelegate,
  ) {
    this.agentRunId = context.agentRunId;
    this.attemptId = context.attemptId;
    this.runtimeGeneration = context.runtimeGeneration;
    this.authority = context.authority;
  }

  cancel(reason: CancelReason): Promise<void> {
    this.assertActive();
    return this.delegate.cancel(this.authority, reason);
  }

  resolveInteraction(
    interactionId: string,
    response: InteractionResponse,
  ): Promise<void> {
    this.assertActive();
    return this.delegate.resolveInteraction(this.authority, interactionId, response);
  }

  getSnapshot(): Promise<AgentRunSnapshot> {
    this.assertActive();
    return this.delegate.getSnapshot(this.agentRunId);
  }

  subscribeEvents(cursor?: EventCursor): AsyncIterable<CanonicalAgentEvent> {
    this.assertActive();
    return this.delegate.subscribeEvents(this.agentRunId, cursor);
  }

  dispose(): void {
    this.disposed = true;
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new AgentRuntimeHostError(
        'handle_disposed',
        `AgentRunHandle for ${this.agentRunId} is disposed`,
      );
    }
  }
}
