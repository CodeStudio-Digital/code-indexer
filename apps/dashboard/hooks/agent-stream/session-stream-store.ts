import { pruneSessions } from './prune-sessions.js';
import type {
  AssistantTurn,
  SessionPatch,
  SessionState,
  UpdateSession,
} from './types.js';
import { EMPTY_STATE } from './types.js';

/**
 * Session-stream state belongs to the dashboard process, not to one React
 * surface. The full chat and the editor rail can both render the same session;
 * mounting either one must not create a second transport or erase the other's
 * cursor/live turn during cleanup.
 */

let sessionStates: Record<number, SessionState> = {};
const sessionTouchedAt = new Map<number, number>();
const sessionListeners = new Map<number, Set<() => void>>();
const currentTurns = new Map<number, AssistantTurn>();
const currentTurnListeners = new Map<number, Set<() => void>>();

export const agentStreamAbortMap = new Map<number, AbortController>();
export const agentStreamLastSeenSeqMap = new Map<number, number>();
export const agentStreamLastSeenBusIdMap = new Map<number, string>();
export const agentStreamAbortRequestMap = new Map<number, Promise<void>>();
export const agentStreamAbortFallbackTimerMap =
  new Map<number, ReturnType<typeof setTimeout>>();

export function getAgentSessionSnapshot(sessionId: number | null): SessionState {
  return sessionId === null ? EMPTY_STATE : (sessionStates[sessionId] ?? EMPTY_STATE);
}

export function subscribeAgentSession(
  sessionId: number | null,
  listener: () => void,
): () => void {
  if (sessionId === null) return () => undefined;
  let listeners = sessionListeners.get(sessionId);
  if (!listeners) {
    listeners = new Set();
    sessionListeners.set(sessionId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
    if (listeners?.size === 0) sessionListeners.delete(sessionId);
  };
}

export function getAgentCurrentTurnSnapshot(
  sessionId: number | null,
): AssistantTurn | null {
  return sessionId === null ? null : (currentTurns.get(sessionId) ?? null);
}

export function subscribeAgentCurrentTurn(
  sessionId: number | null,
  listener: () => void,
): () => void {
  if (sessionId === null) return () => undefined;
  let listeners = currentTurnListeners.get(sessionId);
  if (!listeners) {
    listeners = new Set();
    currentTurnListeners.set(sessionId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
    if (listeners?.size === 0) currentTurnListeners.delete(sessionId);
  };
}

function publishCurrentTurn(
  sessionId: number,
  turn: AssistantTurn | null,
): void {
  if ((currentTurns.get(sessionId) ?? null) === turn) return;
  if (turn) currentTurns.set(sessionId, turn);
  else currentTurns.delete(sessionId);
  for (const listener of currentTurnListeners.get(sessionId) ?? []) listener();
}

function notifySession(sessionId: number): void {
  for (const listener of sessionListeners.get(sessionId) ?? []) listener();
}

/**
 * Shared UpdateSession implementation used by the one logical transport.
 * Token-only patches notify the narrow current-turn store, avoiding a full
 * chat-shell render for every delta. All other state is published to every
 * mounted surface for this session.
 */
export const updateAgentSession: UpdateSession = (sessionId, patch) => {
  sessionTouchedAt.set(sessionId, Date.now());
  const previous = sessionStates;
  const current = previous[sessionId] ?? EMPTY_STATE;
  const next = typeof patch === 'function' ? patch(current) : patch;
  const merged = pruneSessions(
    { ...previous, [sessionId]: { ...current, ...next } },
    sessionId,
    sessionTouchedAt,
  );

  const removed: number[] = [];
  for (const previousId of Object.keys(previous)) {
    const numericId = Number(previousId);
    if (!(numericId in merged)) {
      removed.push(numericId);
      publishCurrentTurn(numericId, null);
    }
  }
  sessionStates = merged;

  if (Object.prototype.hasOwnProperty.call(next, 'currentTurn')) {
    publishCurrentTurn(sessionId, merged[sessionId]?.currentTurn ?? null);
  }

  // The shell deliberately does not subscribe to token-only currentTurn
  // patches. Live transcript surfaces use subscribeAgentCurrentTurn instead.
  if (Object.keys(next).some((key) => key !== 'currentTurn')) {
    notifySession(sessionId);
  }
  for (const removedId of removed) notifySession(removedId);
};

export interface AgentStreamCursor {
  seq: number;
  busId?: string;
}

/** A sequence is valid only together with the bus that allocated it. */
export function readAgentStreamCursor(sessionId: number): AgentStreamCursor {
  const busId = agentStreamLastSeenBusIdMap.get(sessionId);
  return busId
    ? { busId, seq: agentStreamLastSeenSeqMap.get(sessionId) ?? -1 }
    : { seq: -1 };
}

export type AgentStreamConsumerId = symbol;
export type AgentStreamStartKind = 'attach' | 'command';

interface ActiveStream {
  token: symbol;
  promise: Promise<void>;
}

/**
 * One transport owner per session. Cursorless GET /attach calls join an
 * existing owner; state-changing POST commands replace it (openStream aborts
 * the prior controller before installing the replacement). Completion
 * callbacks are fan-out subscriptions, so both visible surfaces refetch.
 */
export class AgentStreamOwnership {
  private readonly active = new Map<number, ActiveStream>();
  private readonly completionCallbacks =
    new Map<number, Map<AgentStreamConsumerId, () => void>>();

  run(
    sessionId: number,
    consumerId: AgentStreamConsumerId,
    kind: AgentStreamStartKind,
    onMessageComplete: (() => void) | undefined,
    start: (notifyMessageComplete: () => void) => Promise<void>,
  ): Promise<void> {
    if (onMessageComplete) {
      let callbacks = this.completionCallbacks.get(sessionId);
      if (!callbacks) {
        callbacks = new Map();
        this.completionCallbacks.set(sessionId, callbacks);
      }
      callbacks.set(consumerId, onMessageComplete);
    }

    const existing = this.active.get(sessionId);
    if (kind === 'attach' && existing) return existing.promise;

    const token = Symbol(`agent-stream:${sessionId}`);
    let started: Promise<void>;
    try {
      started = start(() => this.notifyMessageComplete(sessionId));
    } catch (error) {
      started = Promise.reject(error);
    }
    const promise = Promise.resolve(started).finally(() => {
      if (this.active.get(sessionId)?.token === token) {
        this.active.delete(sessionId);
      }
    });
    this.active.set(sessionId, { token, promise });
    return promise;
  }

  releaseConsumer(
    consumerId: AgentStreamConsumerId,
    sessionId?: number,
  ): void {
    const entries = sessionId === undefined
      ? [...this.completionCallbacks.entries()]
      : [[sessionId, this.completionCallbacks.get(sessionId)] as const];
    for (const [sid, callbacks] of entries) {
      if (!callbacks) continue;
      callbacks.delete(consumerId);
      if (callbacks.size === 0) this.completionCallbacks.delete(sid);
    }
  }

  isActive(sessionId: number): boolean {
    return this.active.has(sessionId);
  }

  private notifyMessageComplete(sessionId: number): void {
    const callbacks = [
      ...(this.completionCallbacks.get(sessionId)?.values() ?? []),
    ];
    for (const callback of callbacks) {
      try {
        callback();
      } catch {
        // A detached surface's refetch is best-effort and must never break
        // the shared stream pipeline for every other consumer.
      }
    }
  }

  /** Test-only reset; production lifetime is the dashboard renderer process. */
  reset(): void {
    this.active.clear();
    this.completionCallbacks.clear();
  }
}

export const agentStreamOwnership = new AgentStreamOwnership();

/** Test-only reset for module-global process state. */
export function __resetAgentStreamStoreForTests(): void {
  for (const controller of agentStreamAbortMap.values()) controller.abort();
  for (const timer of agentStreamAbortFallbackTimerMap.values()) clearTimeout(timer);
  sessionStates = {};
  sessionTouchedAt.clear();
  sessionListeners.clear();
  currentTurns.clear();
  currentTurnListeners.clear();
  agentStreamAbortMap.clear();
  agentStreamLastSeenSeqMap.clear();
  agentStreamLastSeenBusIdMap.clear();
  agentStreamAbortRequestMap.clear();
  agentStreamAbortFallbackTimerMap.clear();
  agentStreamOwnership.reset();
}
