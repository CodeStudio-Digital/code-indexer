import { pruneSessions } from './prune-sessions.js';
import type {
  AssistantTurn,
  SessionId,
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

let sessionStates: Record<SessionId, SessionState> = {};
const sessionTouchedAt = new Map<SessionId, number>();
const sessionListeners = new Map<SessionId, Set<() => void>>();
const currentTurns = new Map<SessionId, AssistantTurn>();
const currentTurnListeners = new Map<SessionId, Set<() => void>>();
const activeSessionListeners = new Set<() => void>();
let activeSessionIdsSnapshot: readonly SessionId[] = [];
export interface AgentSessionActivity { active: boolean; terminal: boolean; busId?: string }
let activitySnapshot: Readonly<Record<SessionId, AgentSessionActivity>> = {};
export const getAgentSessionActivitySnapshot = () => activitySnapshot;

export const agentStreamAbortMap = new Map<SessionId, AbortController>();
export const agentStreamLastSeenSeqMap = new Map<SessionId, number>();
export const agentStreamLastSeenBusIdMap = new Map<SessionId, string>();
export const agentStreamAbortRequestMap = new Map<SessionId, Promise<void>>();
export const agentStreamAbortFallbackTimerMap =
  new Map<SessionId, ReturnType<typeof setTimeout>>();

export function getAgentSessionSnapshot(sessionId: SessionId | null): SessionState {
  return sessionId === null ? EMPTY_STATE : (sessionStates[sessionId] ?? EMPTY_STATE);
}

export function subscribeAgentSession(
  sessionId: SessionId | null,
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

/**
 * Process-wide live-run snapshot used by navigation surfaces. A session can
 * keep streaming after the user switches chats, so the sidebar must not infer
 * activity only from whichever conversation is currently mounted.
 */
export function getActiveAgentSessionIdsSnapshot(): readonly SessionId[] {
  return activeSessionIdsSnapshot;
}

export function subscribeActiveAgentSessions(listener: () => void): () => void {
  activeSessionListeners.add(listener);
  return () => activeSessionListeners.delete(listener);
}

function publishActiveAgentSessions(): void {
  const activity = Object.fromEntries(Object.entries(sessionStates).map(([id, state]) => [id, {
    active: state.streaming, terminal: !!state.doneReason, busId: agentStreamLastSeenBusIdMap.get(id),
  }]));
  const activityChanged = Object.keys(activity).length !== Object.keys(activitySnapshot).length
    || Object.entries(activity).some(([id, value]) => {
      const old = activitySnapshot[id];
      return !old || old.active !== value.active || old.terminal !== value.terminal || old.busId !== value.busId;
    });
  if (activityChanged) activitySnapshot = activity;
  const next = Object.entries(sessionStates)
    .filter(([, state]) => state.streaming)
    .map(([sessionId]) => sessionId);
  if (
    next.length === activeSessionIdsSnapshot.length
    && next.every((sessionId, index) => sessionId === activeSessionIdsSnapshot[index])
    && !activityChanged
  ) return;
  activeSessionIdsSnapshot = next;
  for (const listener of activeSessionListeners) listener();
}

export function getAgentCurrentTurnSnapshot(
  sessionId: SessionId | null,
): AssistantTurn | null {
  return sessionId === null ? null : (currentTurns.get(sessionId) ?? null);
}

export function subscribeAgentCurrentTurn(
  sessionId: SessionId | null,
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
  sessionId: SessionId,
  turn: AssistantTurn | null,
): void {
  if ((currentTurns.get(sessionId) ?? null) === turn) return;
  if (turn) currentTurns.set(sessionId, turn);
  else currentTurns.delete(sessionId);
  for (const listener of currentTurnListeners.get(sessionId) ?? []) listener();
}

function notifySession(sessionId: SessionId): void {
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

  const removed: SessionId[] = [];
  for (const previousId of Object.keys(previous)) {
    if (!(previousId in merged)) {
      removed.push(previousId);
      publishCurrentTurn(previousId, null);
    }
  }
  sessionStates = merged;

  // Publish only when run membership can have changed. In particular, avoid
  // scanning/notifying the navigation store for token-only currentTurn churn.
  if (Object.prototype.hasOwnProperty.call(next, 'streaming') || removed.length > 0) {
    publishActiveAgentSessions();
  }

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

interface AgentStreamCursor {
  seq: number;
  busId?: string;
}

/** A sequence is valid only together with the bus that allocated it. */
export function readAgentStreamCursor(sessionId: SessionId): AgentStreamCursor {
  const busId = agentStreamLastSeenBusIdMap.get(sessionId);
  return busId
    ? { busId, seq: agentStreamLastSeenSeqMap.get(sessionId) ?? -1 }
    : { seq: -1 };
}

type AgentStreamConsumerId = symbol;
type AgentStreamStartKind = 'attach' | 'command';

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
  private readonly active = new Map<SessionId, ActiveStream>();
  private readonly completionCallbacks =
    new Map<SessionId, Map<AgentStreamConsumerId, () => void>>();

  run(
    sessionId: SessionId,
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
    sessionId?: SessionId,
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

  isActive(sessionId: SessionId): boolean {
    return this.active.has(sessionId);
  }

  forget(sessionId: SessionId): void {
    this.active.delete(sessionId);
    this.completionCallbacks.delete(sessionId);
  }

  private notifyMessageComplete(sessionId: SessionId): void {
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

/** Called only after the backend confirms deletion; late readers lose ownership. */
export function forgetAgentSession(sessionId: SessionId): void {
  const controller = agentStreamAbortMap.get(sessionId);
  agentStreamAbortMap.delete(sessionId);
  controller?.abort();
  clearTimeout(agentStreamAbortFallbackTimerMap.get(sessionId));
  agentStreamAbortFallbackTimerMap.delete(sessionId);
  agentStreamAbortRequestMap.delete(sessionId);
  agentStreamLastSeenSeqMap.delete(sessionId);
  agentStreamLastSeenBusIdMap.delete(sessionId);
  agentStreamOwnership.forget(sessionId);
  delete sessionStates[sessionId];
  sessionTouchedAt.delete(sessionId);
  publishCurrentTurn(sessionId, null);
  publishActiveAgentSessions();
  notifySession(sessionId);
}

/** Test-only reset for module-global process state. */
export function __resetAgentStreamStoreForTests(): void {
  for (const controller of agentStreamAbortMap.values()) controller.abort();
  for (const timer of agentStreamAbortFallbackTimerMap.values()) clearTimeout(timer);
  sessionStates = {};
  sessionTouchedAt.clear();
  sessionListeners.clear();
  currentTurns.clear();
  currentTurnListeners.clear();
  activeSessionIdsSnapshot = [];
  activitySnapshot = {};
  activeSessionListeners.clear();
  agentStreamAbortMap.clear();
  agentStreamLastSeenSeqMap.clear();
  agentStreamLastSeenBusIdMap.clear();
  agentStreamAbortRequestMap.clear();
  agentStreamAbortFallbackTimerMap.clear();
  agentStreamOwnership.reset();
}
