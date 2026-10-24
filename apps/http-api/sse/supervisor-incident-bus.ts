/**
 * Process-wide supervisor incident bus (Sprint 4 Phase 3.2).
 *
 * Each company-worker emits `supervisor.incident` via the MessageBridge;
 * `WorkerOrchestratorPool.attachBusMirror` translates the bridge event
 * into `publishSupervisorIncident(payload)` on this singleton bus.
 *
 * SSE endpoint subscribers (`/api/admin/supervisor/stream`) call
 * `subscribeToSupervisorIncidents(listener)` and receive every incident
 * fired anywhere in the process, plus an optional replay of the most
 * recent N incidents so dashboards that connect mid-storm get context.
 *
 * Listeners are best-effort: if a subscriber throws, the bus catches and
 * continues so one bad listener can't break delivery to the others.
 */
import type { AgentRunId } from '@mcp/agent-runtime-contracts';
import type { CompanySessionId } from '@mcp/session-storage';

/** Shape forwarded from the worker bridge. */
export interface SupervisorIncidentEnvelope {
  sessionId: CompanySessionId;
  kind: string;
  agentRunId: AgentRunId | null;
  fromState?: string;
  attemptedTo?: string;
  detail: string;
  detectedAtMs: number;
}

type SupervisorIncidentListener = (env: SupervisorIncidentEnvelope) => void;

/**
 * Bounded ring of recent incidents. Lets new SSE subscribers replay
 * what they missed so the dashboard shows context immediately on
 * connect. Capacity is small on purpose — the immutable incident files in the
 * owning Company bundle are the source of truth for history.
 */
const RING_CAPACITY = 100;

class SupervisorIncidentBus {
  private readonly listeners = new Set<SupervisorIncidentListener>();
  private ring: SupervisorIncidentEnvelope[] = [];

  publish(envelope: SupervisorIncidentEnvelope): void {
    // Append to ring (bounded).
    this.ring.push(envelope);
    if (this.ring.length > RING_CAPACITY) {
      this.ring = this.ring.slice(-RING_CAPACITY);
    }
    // Snapshot the listener set so concurrent on/off during dispatch
    // doesn't change the invocation order.
    const snapshot = Array.from(this.listeners);
    for (const fn of snapshot) {
      try {
        fn(envelope);
      } catch (e) {
        // One listener bug must not break others.
        console.warn('[supervisor-incident-bus] listener threw:', e);
      }
    }
  }

  subscribe(listener: SupervisorIncidentListener): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  /** Snapshot of recent incidents (newest LAST). Caller may copy/iterate. */
  recent(limit: number = RING_CAPACITY): SupervisorIncidentEnvelope[] {
    if (limit >= this.ring.length) return this.ring.slice();
    return this.ring.slice(-limit);
  }

  listenerCount(): number {
    return this.listeners.size;
  }

  /** Test helper — reset state between tests. */
  clearForTests(): void {
    this.listeners.clear();
    this.ring = [];
  }
}

const bus = new SupervisorIncidentBus();

export function publishSupervisorIncident(env: SupervisorIncidentEnvelope): void {
  bus.publish(env);
}

export function subscribeToSupervisorIncidents(
  listener: SupervisorIncidentListener,
): () => void {
  return bus.subscribe(listener);
}

export function recentSupervisorIncidents(
  limit: number = RING_CAPACITY,
): SupervisorIncidentEnvelope[] {
  return bus.recent(limit);
}

export function supervisorIncidentListenerCount(): number {
  return bus.listenerCount();
}

export function clearSupervisorIncidentBusForTests(): void {
  bus.clearForTests();
}
