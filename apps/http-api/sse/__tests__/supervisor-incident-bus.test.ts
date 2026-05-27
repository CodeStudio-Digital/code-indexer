/**
 * Tests for the supervisor incident bus (Sprint 4 Phase 3.2).
 *
 * Locks in:
 *   - publish → all current subscribers receive
 *   - subscribe returns unsubscribe; unsubscribed listeners stop receiving
 *   - One throwing listener doesn't break others
 *   - Ring buffer caps at RING_CAPACITY; recent() returns newest tail
 *   - Listener snapshot at publish time — adds/removes during dispatch
 *     don't affect the in-flight delivery
 *   - listenerCount tracks correctly
 *   - clearForTests resets state
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  publishSupervisorIncident,
  subscribeToSupervisorIncidents,
  recentSupervisorIncidents,
  supervisorIncidentListenerCount,
  clearSupervisorIncidentBusForTests,
  type SupervisorIncidentEnvelope,
} from '../supervisor-incident-bus.js';

function env(over: Partial<SupervisorIncidentEnvelope> = {}): SupervisorIncidentEnvelope {
  return {
    sessionId: 42,
    kind: 'stuck_detected',
    agentRunId: 1,
    detail: 'test',
    detectedAtMs: Date.now(),
    ...over,
  };
}

beforeEach(() => {
  clearSupervisorIncidentBusForTests();
});

describe('publish / subscribe', () => {
  it('delivers to current subscribers', () => {
    const seen: SupervisorIncidentEnvelope[] = [];
    subscribeToSupervisorIncidents((e) => seen.push(e));
    publishSupervisorIncident(env({ kind: 'agent_quarantined' }));
    expect(seen).toHaveLength(1);
    expect(seen[0].kind).toBe('agent_quarantined');
  });

  it('unsubscribe stops further delivery', () => {
    const seen: SupervisorIncidentEnvelope[] = [];
    const off = subscribeToSupervisorIncidents((e) => seen.push(e));
    publishSupervisorIncident(env());
    off();
    publishSupervisorIncident(env({ kind: 'role_quarantined' }));
    expect(seen).toHaveLength(1);
    expect(seen[0].kind).toBe('stuck_detected');
  });

  it('multiple listeners all receive', () => {
    const a: SupervisorIncidentEnvelope[] = [];
    const b: SupervisorIncidentEnvelope[] = [];
    subscribeToSupervisorIncidents((e) => a.push(e));
    subscribeToSupervisorIncidents((e) => b.push(e));
    publishSupervisorIncident(env());
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('one throwing listener does NOT break others', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const survivor: SupervisorIncidentEnvelope[] = [];
    subscribeToSupervisorIncidents(() => {
      throw new Error('boom');
    });
    subscribeToSupervisorIncidents((e) => survivor.push(e));
    publishSupervisorIncident(env());
    expect(survivor).toHaveLength(1);
    consoleSpy.mockRestore();
  });

  it('listenerCount reflects current subscribers', () => {
    expect(supervisorIncidentListenerCount()).toBe(0);
    const a = subscribeToSupervisorIncidents(() => {});
    const b = subscribeToSupervisorIncidents(() => {});
    expect(supervisorIncidentListenerCount()).toBe(2);
    a();
    expect(supervisorIncidentListenerCount()).toBe(1);
    b();
    expect(supervisorIncidentListenerCount()).toBe(0);
  });

  it('publish snapshots listeners — subscribe during dispatch sees only future', () => {
    const a: SupervisorIncidentEnvelope[] = [];
    const lateB: SupervisorIncidentEnvelope[] = [];
    subscribeToSupervisorIncidents((e) => {
      a.push(e);
      if (a.length === 1) {
        subscribeToSupervisorIncidents((later) => lateB.push(later));
      }
    });
    publishSupervisorIncident(env({ kind: 'first' }));
    expect(a).toHaveLength(1);
    expect(lateB).toHaveLength(0);
    publishSupervisorIncident(env({ kind: 'second' }));
    expect(a).toHaveLength(2);
    expect(lateB).toHaveLength(1);
    expect(lateB[0].kind).toBe('second');
  });
});

describe('ring buffer', () => {
  it('recent() returns published incidents in order', () => {
    publishSupervisorIncident(env({ kind: 'a' }));
    publishSupervisorIncident(env({ kind: 'b' }));
    publishSupervisorIncident(env({ kind: 'c' }));
    const r = recentSupervisorIncidents();
    expect(r.map((e) => e.kind)).toEqual(['a', 'b', 'c']);
  });

  it('recent(limit) returns only newest N', () => {
    for (let i = 0; i < 10; i++) publishSupervisorIncident(env({ kind: `k${i}` }));
    const r = recentSupervisorIncidents(3);
    expect(r.map((e) => e.kind)).toEqual(['k7', 'k8', 'k9']);
  });

  it('caps at RING_CAPACITY (100) — oldest evicted', () => {
    for (let i = 0; i < 150; i++) publishSupervisorIncident(env({ kind: `k${i}` }));
    const r = recentSupervisorIncidents();
    expect(r).toHaveLength(100);
    // Should be k50..k149
    expect(r[0].kind).toBe('k50');
    expect(r[r.length - 1].kind).toBe('k149');
  });
});

describe('clearForTests', () => {
  it('resets ring + listeners', () => {
    subscribeToSupervisorIncidents(() => {});
    publishSupervisorIncident(env());
    expect(supervisorIncidentListenerCount()).toBe(1);
    expect(recentSupervisorIncidents()).toHaveLength(1);
    clearSupervisorIncidentBusForTests();
    expect(supervisorIncidentListenerCount()).toBe(0);
    expect(recentSupervisorIncidents()).toHaveLength(0);
  });
});
