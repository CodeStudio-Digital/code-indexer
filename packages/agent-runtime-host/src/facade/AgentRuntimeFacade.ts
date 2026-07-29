import type { AgentRunId } from '@mcp/agent-runtime-contracts';
import {
  AgentRunHandle,
  type AgentRunHandleApi,
  type AgentRunHandleDelegate,
} from './AgentRunHandle.js';
import { AgentRuntimeHostError } from '../errors.js';
import type {
  AgentControlPlanePort,
  AgentRuntimeAdapterPort,
} from './ports.js';
import {
  assertPreparedAttempt,
  assertPreparedAttemptCurrent,
} from './prepared-validation.js';
import { RuntimeRouter } from '../router/RuntimeRouter.js';
import type { RuntimeClockPort } from '../router/ports.js';
import type {
  AgentRuntimeGeneration,
  RuntimeRouteRecord,
} from '../router/types.js';
import type {
  AgentRunSnapshot,
  AttemptAuthority,
  AttemptStartFailurePhase,
  CancelReason,
  CanonicalAgentEvent,
  EventCursor,
  InteractionResponse,
  PreparedAgentAttempt,
  ResumeAgentCommand,
  StartAgentCommand,
} from './types.js';

export interface AgentRuntimeFacadeApi extends AgentRunHandleDelegate {
  start(command: StartAgentCommand): Promise<AgentRunHandleApi>;
  resume(command: ResumeAgentCommand): Promise<AgentRunHandleApi>;
}

export interface AgentRuntimeFacadeDependencies {
  controlPlane: AgentControlPlanePort;
  router: RuntimeRouter;
  runtimeAdapters: readonly AgentRuntimeAdapterPort[];
  clock?: RuntimeClockPort;
}

const systemClock: RuntimeClockPort = { now: () => new Date() };

export class AgentRuntimeFacade implements AgentRuntimeFacadeApi {
  private readonly controlPlane: AgentControlPlanePort;
  private readonly router: RuntimeRouter;
  private readonly adapters: ReadonlyMap<AgentRuntimeGeneration, AgentRuntimeAdapterPort>;
  private readonly clock: RuntimeClockPort;

  constructor(dependencies: AgentRuntimeFacadeDependencies) {
    this.controlPlane = dependencies.controlPlane;
    this.router = dependencies.router;
    this.adapters = this.indexAdapters(dependencies.runtimeAdapters);
    this.clock = dependencies.clock ?? systemClock;
  }

  async start(command: StartAgentCommand): Promise<AgentRunHandleApi> {
    const prepared = await this.controlPlane.prepareStart(command);
    await this.validatePreparedCommand(prepared, command);
    return this.launchPrepared(prepared);
  }

  async resume(command: ResumeAgentCommand): Promise<AgentRunHandleApi> {
    const prepared = await this.controlPlane.prepareResume(command);
    await this.validatePreparedCommand(prepared, command, command.payload.agentRunId);
    return this.launchPrepared(prepared);
  }

  async cancel(authority: AttemptAuthority, reason: CancelReason): Promise<void> {
    await this.controlPlane.commitCancelRequest(authority, reason);
    const route = await this.router.getCommittedRoute(authority.attemptId);
    const adapter = this.requireAdapter(route.runtimeGeneration);
    await adapter.cancel(authority, reason);
  }

  resolveInteraction(
    authority: AttemptAuthority,
    interactionId: string,
    response: InteractionResponse,
  ): Promise<void> {
    return this.controlPlane.resolveInteraction(authority, interactionId, response);
  }

  getSnapshot(agentRunId: AgentRunId): Promise<AgentRunSnapshot> {
    return this.controlPlane.getSnapshot(agentRunId);
  }

  subscribeEvents(
    agentRunId: AgentRunId,
    cursor?: EventCursor,
  ): AsyncIterable<CanonicalAgentEvent> {
    return this.controlPlane.subscribeEvents(agentRunId, cursor);
  }

  private async launchPrepared(
    prepared: PreparedAgentAttempt,
  ): Promise<AgentRunHandleApi> {
    let phase: AttemptStartFailurePhase = 'routing';
    try {
      const route = await this.router.route(prepared.routing);
      phase = 'adapter_lookup';
      const adapter = this.requireAdapter(route.runtimeGeneration);
      phase = 'launch';
      assertPreparedAttemptCurrent(prepared, this.clock.now());
      await adapter.launch(prepared, route);
      return this.createHandle(prepared, route);
    } catch (error) {
      await this.commitStartFailure(prepared, phase, error);
      throw error;
    }
  }

  private createHandle(
    prepared: PreparedAgentAttempt,
    route: RuntimeRouteRecord,
  ): AgentRunHandle {
    return new AgentRunHandle({
      agentRunId: prepared.run.agentRunId,
      attemptId: prepared.attempt.attemptId,
      runtimeGeneration: route.runtimeGeneration,
      authority: prepared.authority,
    }, this);
  }

  private requireAdapter(generation: AgentRuntimeGeneration): AgentRuntimeAdapterPort {
    const adapter = this.adapters.get(generation);
    if (!adapter) {
      throw new AgentRuntimeHostError(
        'runtime_adapter_unavailable',
        `No runtime adapter is installed for ${generation}`,
      );
    }
    return adapter;
  }

  private indexAdapters(
    adapters: readonly AgentRuntimeAdapterPort[],
  ): ReadonlyMap<AgentRuntimeGeneration, AgentRuntimeAdapterPort> {
    const indexed = new Map<AgentRuntimeGeneration, AgentRuntimeAdapterPort>();
    for (const adapter of adapters) {
      if (indexed.has(adapter.generation)) {
        throw new AgentRuntimeHostError(
          'runtime_adapter_unavailable',
          `Multiple runtime adapters are installed for ${adapter.generation}`,
        );
      }
      indexed.set(adapter.generation, adapter);
    }
    return indexed;
  }

  private async validatePreparedCommand(
    prepared: PreparedAgentAttempt,
    command: StartAgentCommand | ResumeAgentCommand,
    expectedAgentRunId?: AgentRunId,
  ): Promise<void> {
    try {
      assertPreparedAttempt(prepared, command, this.clock.now(), expectedAgentRunId);
    } catch (error) {
      await this.commitStartFailure(prepared, 'routing', error);
      throw error;
    }
  }

  private async commitStartFailure(
    prepared: PreparedAgentAttempt,
    phase: AttemptStartFailurePhase,
    error: unknown,
  ): Promise<void> {
    const code = error instanceof AgentRuntimeHostError
      ? error.code
      : 'attempt_start_failed';
    const message = error instanceof Error ? error.message : String(error);
    try {
      await this.controlPlane.commitAttemptStartFailure({
        prepared,
        phase,
        code,
        message,
      });
    } catch (commitError) {
      throw new AggregateError(
        [error, commitError],
        `Attempt start failed during ${phase}, and its failure could not be committed`,
      );
    }
  }
}
