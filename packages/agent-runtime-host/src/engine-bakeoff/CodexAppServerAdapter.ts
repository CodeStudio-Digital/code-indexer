import type { EngineJsonRpcPeerPort } from './JsonRpcPeer.js';
import { handleCodexNotification, handleCodexRequest } from './CodexAppServerHandlers.js';
import {
  asRecord,
  bindId,
  buildThreadStartParams,
  createRunState,
  elapsedMs,
  emit,
  engineEvent,
  nestedId,
  OssEngineAdapterError,
  raceWithSignal,
  requireBoundId,
  type RunState,
  signalForDeadline,
  waitForTerminal,
} from './CodexAppServerSupport.js';
import type {
  OssEngineAttemptSpec,
  OssEngineClockPort,
  OssEngineEventSink,
  OssEngineRunResult,
  OssEngineToolHostPort,
} from './types.js';
import {
  DEFAULT_OSS_ENGINE_LIMITS,
  dynamicToolAlias,
  type OssEngineValidationLimits,
  validateOssEngineAttemptSpec,
} from './validation.js';

export { OssEngineAdapterError } from './CodexAppServerSupport.js';

export interface CodexAppServerAdapterOptions {
  clientVersion: string;
  interruptGraceMs?: number;
  limits?: OssEngineValidationLimits;
  clock?: OssEngineClockPort;
}

export class CodexAppServerAdapter {
  readonly #clock: OssEngineClockPort;
  readonly #limits: OssEngineValidationLimits;
  readonly #interruptGraceMs: number;

  constructor(
    private readonly peer: EngineJsonRpcPeerPort,
    private readonly toolHost: OssEngineToolHostPort,
    private readonly options: CodexAppServerAdapterOptions,
  ) {
    this.#clock = options.clock ?? { now: () => new Date() };
    this.#limits = options.limits ?? DEFAULT_OSS_ENGINE_LIMITS;
    this.#interruptGraceMs = options.interruptGraceMs ?? 1_500;
  }

  async run(
    spec: OssEngineAttemptSpec,
    sink: OssEngineEventSink,
    signal: AbortSignal,
  ): Promise<OssEngineRunResult> {
    if (spec.candidate !== 'codex_app_server') {
      throw new OssEngineAdapterError('candidate_mismatch', 'Codex adapter received another candidate');
    }
    validateOssEngineAttemptSpec(spec, this.#limits);
    const startedAt = this.#clock.now();
    const lifetime = AbortSignal.any([
      signal,
      signalForDeadline(spec.authority.deadlineAtUnixMs, startedAt),
    ]);
    const state = createRunState();
    const aliases = new Map(
      spec.capabilities.map((capability) => [dynamicToolAlias(capability), capability]),
    );
    let initializeMs = 0;
    let threadStartMs = 0;
    let turnStartMs = 0;
    let temporaryStateDeleted = false;
    let threadDeleteAttempted = false;
    const peerLifetime = new AbortController();

    this.peer.start({
      onNotification: (method, params) => handleCodexNotification(method, params, {
        spec,
        state,
        sink,
        clock: this.#clock,
      }),
      onRequest: (method, params, requestSignal) => handleCodexRequest(
        method,
        params,
        AbortSignal.any([lifetime, requestSignal]),
        {
          spec,
          state,
          aliases,
          sink,
          clock: this.#clock,
          toolHost: this.toolHost,
          limits: this.#limits,
        },
      ),
      onClosed: (error) => {
        if (!state.terminal.settled) {
          state.terminal.reject(error ?? new OssEngineAdapterError('peer_closed', 'Codex peer closed'));
        }
      },
    }, peerLifetime.signal);

    try {
      const initializeStarted = this.#clock.now();
      await this.peer.request('initialize', {
        clientInfo: {
          name: 'codestudio_oss_bakeoff',
          title: 'CodeStudio OSS Engine Bake-off',
          version: this.options.clientVersion,
        },
        capabilities: { experimentalApi: true },
      }, lifetime);
      initializeMs = elapsedMs(initializeStarted, this.#clock.now());
      await this.peer.notify('initialized', {});
      await emit(sink, engineEvent(spec, this.#clock.now(), 'engine_initialized'));

      const threadStarted = this.#clock.now();
      const threadResult = asRecord(await this.peer.request(
        'thread/start',
        buildThreadStartParams(spec, aliases),
        lifetime,
      ), 'thread_start_result_invalid');
      state.threadId = bindId(state.threadId, nestedId(threadResult, 'thread'), 'thread');
      threadStartMs = elapsedMs(threadStarted, this.#clock.now());
      await emit(sink, engineEvent(spec, this.#clock.now(), 'thread_started', state));

      const turnStarted = this.#clock.now();
      const turnResult = asRecord(await this.peer.request('turn/start', {
        threadId: state.threadId,
        input: [{ type: 'text', text: spec.prompt }],
        cwd: spec.cwd,
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly' },
        ...(spec.model ? { model: spec.model } : {}),
      }, lifetime), 'turn_start_result_invalid');
      state.turnId = bindId(state.turnId, nestedId(turnResult, 'turn'), 'turn');
      turnStartMs = elapsedMs(turnStarted, this.#clock.now());
      if (!state.turnStartedEmitted) {
        state.turnStartedEmitted = true;
        await emit(sink, engineEvent(spec, this.#clock.now(), 'turn_started', state));
      }

      const status = await waitForTerminal(state.terminal, lifetime, () => this.#interrupt(state));
      threadDeleteAttempted = true;
      temporaryStateDeleted = await this.#deleteThread(spec, state, sink);
      const completedAt = this.#clock.now();
      return {
        candidate: spec.candidate,
        candidateVersion: spec.candidateVersion,
        protocolVersion: spec.protocolVersion,
        protocolSchemaDigest: spec.protocolSchemaDigest,
        attemptId: spec.authority.attemptId,
        threadId: requireBoundId(state.threadId, 'thread'),
        turnId: requireBoundId(state.turnId, 'turn'),
        status,
        metrics: {
          startedAt: startedAt.toISOString(),
          completedAt: completedAt.toISOString(),
          initializeMs,
          threadStartMs,
          turnStartMs,
          firstDeltaMs: state.firstDeltaAt
            ? elapsedMs(startedAt, state.firstDeltaAt)
            : undefined,
          dynamicToolCount: aliases.size,
          toolCallCount: state.toolCallCount,
          deniedBuiltInRequestCount: state.deniedBuiltInRequestCount,
          observedBypassToolCount: state.observedBypassToolCount,
          temporaryStateDeleted,
        },
      };
    } finally {
      if (!threadDeleteAttempted && state.threadId) {
        await this.#deleteThread(spec, state, sink).catch(() => false);
      }
      if (!state.terminal.settled) state.terminal.resolve('failed');
      peerLifetime.abort();
      await this.peer.close();
    }
  }

  async #interrupt(state: RunState): Promise<'completed' | 'interrupted' | 'failed'> {
    if (!state.threadId || !state.turnId) {
      throw new OssEngineAdapterError('interrupt_without_turn', 'Cannot interrupt an unbound turn');
    }
    const graceSignal = AbortSignal.timeout(this.#interruptGraceMs);
    await this.peer.request('turn/interrupt', {
      threadId: state.threadId,
      turnId: state.turnId,
    }, graceSignal);
    return raceWithSignal(state.terminal.promise, graceSignal);
  }

  async #deleteThread(
    spec: OssEngineAttemptSpec,
    state: RunState,
    sink: OssEngineEventSink,
  ): Promise<boolean> {
    if (!state.threadId) return false;
    try {
      await this.peer.request('thread/delete', { threadId: state.threadId }, AbortSignal.timeout(1_500));
      await emit(sink, engineEvent(spec, this.#clock.now(), 'temporary_state_deleted', state));
      return true;
    } catch (error) {
      await emit(sink, engineEvent(spec, this.#clock.now(), 'warning', state, {
        status: 'temporary_state_delete_failed',
        text: error instanceof Error ? error.message : String(error),
      }));
      return false;
    }
  }
}
