import type { SessionId } from '@mcp/agent-runtime-contracts';
import type { SessionWorkbenchEvent } from '@mcp/api-bus';

type SessionWorkbenchEventListener = (event: SessionWorkbenchEvent) => void;

const RETAINED_EVENTS_PER_SESSION = 1_000;
const MAX_RETAINED_SESSIONS = 32;

class SessionWorkbenchEventHub {
  private readonly listeners = new Map<SessionId, Set<SessionWorkbenchEventListener>>();
  private readonly retained = new Map<SessionId, SessionWorkbenchEvent[]>();

  publish(event: SessionWorkbenchEvent): void {
    const events = this.retained.get(event.sessionId) ?? [];
    events.push(event);
    if (events.length > RETAINED_EVENTS_PER_SESSION) {
      events.splice(0, events.length - RETAINED_EVENTS_PER_SESSION);
    }
    this.retained.delete(event.sessionId);
    this.retained.set(event.sessionId, events);
    if (this.retained.size > MAX_RETAINED_SESSIONS) {
      for (const candidate of this.retained.keys()) {
        if (this.listeners.has(candidate)) continue;
        this.retained.delete(candidate);
        break;
      }
    }
    for (const listener of this.listeners.get(event.sessionId) ?? []) {
      try { listener(event); } catch { /* one observer cannot break command commit */ }
    }
  }

  subscribe(sessionId: SessionId, listener: SessionWorkbenchEventListener): () => void {
    const listeners = this.listeners.get(sessionId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(sessionId);
    };
  }

  recent(sessionId: SessionId): readonly SessionWorkbenchEvent[] {
    return this.retained.get(sessionId) ?? [];
  }
}

const hub = new SessionWorkbenchEventHub();

export function publishSessionWorkbenchEvent(event: SessionWorkbenchEvent): void {
  hub.publish(event);
}

function subscribeToSessionWorkbenchEvents(
  sessionId: SessionId,
  listener: SessionWorkbenchEventListener,
): () => void {
  return hub.subscribe(sessionId, listener);
}

function recentSessionWorkbenchEvents(
  sessionId: SessionId,
): readonly SessionWorkbenchEvent[] {
  return hub.recent(sessionId);
}
