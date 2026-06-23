/**
 * Tests for SupervisionPersistence layer (Sprint 4 Phase 2.4).
 *
 * Locks in:
 *   - NullSupervisionPersistence is no-op everywhere
 *   - detectGhostRunning identifies stale non-terminal records
 *   - HeartbeatTracker.setPersistence wires writes through register /
 *     transition / unregister / recordIncident / recordRecoveryAttempt
 *   - hydrate skips duplicates, returns added count
 *   - heartbeatSnapshot excludes terminal records
 *   - persistence failures inside tracker do NOT throw
 */
import { describe, expect, it, vi } from 'vitest';
import {
  HeartbeatTracker,
  type AgentSupervisionRecord,
} from '../heartbeat-tracker.js';
import {
  NullSupervisionPersistence,
  detectGhostRunning,
  type SupervisionPersistence,
} from '../persistence.js';

function makeRecord(over: Partial<AgentSupervisionRecord> = {}): AgentSupervisionRecord {
  return {
    agentRunId: 1,
    companySessionId: 100,
    role: 'frontend',
    state: 'RUNNING_TURN',
    enteredAt: 0,
    lastHeartbeatAt: 0,
    currentToolUseId: null,
    currentToolName: null,
    stateTimeoutMsOverride: null,
    recoveryAttempts: 0,
    incidentCount: 0,
    ...over,
  };
}

/** In-memory test impl that captures calls without touching DB. */
class CapturingPersistence implements SupervisionPersistence {
  records: AgentSupervisionRecord[] = [];
  heartbeatBatches: Array<ReadonlyArray<{ agentRunId: number; lastHeartbeatAt: number }>> = [];
  incidents: Array<unknown> = [];
  deletes: number[] = [];

  setSeed(records: AgentSupervisionRecord[]): void {
    this.records = records.map((r) => ({ ...r }));
  }
  loadAll(): AgentSupervisionRecord[] {
    return this.records.map((r) => ({ ...r }));
  }
  saveRecord(record: AgentSupervisionRecord): void {
    const idx = this.records.findIndex((r) => r.agentRunId === record.agentRunId);
    if (idx >= 0) this.records[idx] = { ...record };
    else this.records.push({ ...record });
  }
  saveHeartbeats(records: ReadonlyArray<{ agentRunId: number; lastHeartbeatAt: number }>): void {
    this.heartbeatBatches.push(records.slice());
  }
  deleteRecord(agentRunId: number): void {
    this.deletes.push(agentRunId);
    this.records = this.records.filter((r) => r.agentRunId !== agentRunId);
  }
  saveIncident(incident: unknown): void {
    this.incidents.push(incident);
  }
  listRecentIncidents(): never[] {
    return [];
  }
}

describe('NullSupervisionPersistence', () => {
  it('is a no-op everywhere', () => {
    const p = new NullSupervisionPersistence();
    expect(p.loadAll()).toEqual([]);
    expect(() => p.saveRecord(makeRecord())).not.toThrow();
    expect(() => p.saveHeartbeats([{ agentRunId: 1, lastHeartbeatAt: 1 }])).not.toThrow();
    expect(() => p.deleteRecord(1)).not.toThrow();
    expect(() =>
      p.saveIncident({
        agentRunId: 1,
        companySessionId: 100,
        incidentKind: 'x',
        fromState: null,
        attemptedToState: null,
        detail: 'x',
        detectedAtMs: 0,
      }),
    ).not.toThrow();
    expect(p.listRecentIncidents(1, 10)).toEqual([]);
  });
});

describe('detectGhostRunning', () => {
  it('flags non-terminal records with stale heartbeats', () => {
    const records: AgentSupervisionRecord[] = [
      makeRecord({ agentRunId: 1, state: 'RUNNING_TURN', lastHeartbeatAt: 0 }),
      makeRecord({ agentRunId: 2, state: 'AWAITING_TOOL', lastHeartbeatAt: 0 }),
      makeRecord({ agentRunId: 3, state: 'TERMINAL', lastHeartbeatAt: 0 }), // skip terminal
      makeRecord({ agentRunId: 4, state: 'IDLE', lastHeartbeatAt: 0 }), // skip non-ghostable
      makeRecord({ agentRunId: 5, state: 'RUNNING_TURN', lastHeartbeatAt: 999_999 }), // fresh
    ];
    const ghosts = detectGhostRunning(records, 1_000_000, 60_000);
    expect(ghosts.map((g) => g.agentRunId).sort()).toEqual([1, 2]);
  });

  it('flags BOOTING / AWAITING_PROVIDER / AWAITING_MASTER_APPROVAL / AWAITING_INBOX_ANSWER / RESURRECTING', () => {
    const states = [
      'BOOTING',
      'AWAITING_PROVIDER',
      'AWAITING_MASTER_APPROVAL',
      'AWAITING_INBOX_ANSWER',
      'RESURRECTING',
    ] as const;
    const records = states.map((s, i) =>
      makeRecord({ agentRunId: i + 1, state: s, lastHeartbeatAt: 0 }),
    );
    const ghosts = detectGhostRunning(records, 1_000_000, 60_000);
    expect(ghosts).toHaveLength(5);
  });

  it('does NOT flag QUARANTINED / STUCK_* / FAILED_* (no live process expected)', () => {
    const records: AgentSupervisionRecord[] = [
      makeRecord({ agentRunId: 1, state: 'QUARANTINED', lastHeartbeatAt: 0 }),
      makeRecord({ agentRunId: 2, state: 'STUCK_TURN', lastHeartbeatAt: 0 }),
      makeRecord({ agentRunId: 3, state: 'FAILED_BOOT', lastHeartbeatAt: 0 }),
    ];
    expect(detectGhostRunning(records, 1_000_000, 60_000)).toEqual([]);
  });

  it('returns empty when records are all fresh', () => {
    const records = [
      makeRecord({ agentRunId: 1, state: 'RUNNING_TURN', lastHeartbeatAt: 900_000 }),
    ];
    expect(detectGhostRunning(records, 1_000_000, 200_000)).toEqual([]);
  });
});

describe('HeartbeatTracker with persistence', () => {
  it('register persists the new row', () => {
    const p = new CapturingPersistence();
    const t = new HeartbeatTracker();
    t.setPersistence(p);
    t.register({ agentRunId: 7, companySessionId: 100, role: 'qa' }, 0);
    expect(p.records).toHaveLength(1);
    expect(p.records[0]).toMatchObject({ agentRunId: 7, role: 'qa', state: 'BOOTING' });
  });

  it('transition persists only on real state change', () => {
    const p = new CapturingPersistence();
    const t = new HeartbeatTracker();
    t.setPersistence(p);
    t.register({ agentRunId: 1, companySessionId: 100, role: 'qa' }, 0);
    p.records = []; // reset to isolate transition writes
    // Same-state transition = heartbeat refresh → NO persist
    t.transition(1, 'BOOTING', 100);
    expect(p.records).toHaveLength(0);
    // Real transition → persist
    t.transition(1, 'RUNNING_TURN', 200);
    expect(p.records).toHaveLength(1);
    expect(p.records[0].state).toBe('RUNNING_TURN');
  });

  it('recordIncident + recordRecoveryAttempt persist counters', () => {
    const p = new CapturingPersistence();
    const t = new HeartbeatTracker();
    t.setPersistence(p);
    t.register({ agentRunId: 1, companySessionId: 100, role: 'qa' }, 0);
    p.records = [];
    t.recordIncident(1);
    t.recordRecoveryAttempt(1);
    expect(p.records.length).toBeGreaterThan(0);
    const last = p.records[p.records.length - 1];
    expect(last.incidentCount).toBe(1);
    expect(last.recoveryAttempts).toBe(1);
  });

  it('unregister deletes from persistence', () => {
    const p = new CapturingPersistence();
    const t = new HeartbeatTracker();
    t.setPersistence(p);
    t.register({ agentRunId: 1, companySessionId: 100, role: 'qa' });
    t.unregister(1);
    expect(p.deletes).toEqual([1]);
  });

  it('hydrate adds records without persisting them', () => {
    const p = new CapturingPersistence();
    const t = new HeartbeatTracker();
    t.setPersistence(p);
    const seed = [
      makeRecord({ agentRunId: 1, state: 'RUNNING_TURN' }),
      makeRecord({ agentRunId: 2, state: 'AWAITING_TOOL' }),
    ];
    const n = t.hydrate(seed);
    expect(n).toBe(2);
    expect(t.size()).toBe(2);
    // Hydration mustn't trigger writes (those records came FROM disk).
    expect(p.records).toHaveLength(0);
  });

  it('hydrate skips duplicates', () => {
    const t = new HeartbeatTracker();
    t.register({ agentRunId: 1, companySessionId: 100, role: 'qa' });
    const seed = [makeRecord({ agentRunId: 1, state: 'RUNNING_TURN' })];
    expect(t.hydrate(seed)).toBe(0);
  });

  it('heartbeatSnapshot excludes terminal records', () => {
    const t = new HeartbeatTracker();
    t.register({ agentRunId: 1, companySessionId: 100, role: 'qa' }, 0);
    t.register({ agentRunId: 2, companySessionId: 100, role: 'qa' }, 0);
    t.transition(1, 'RUNNING_TURN', 100);
    t.transition(2, 'RUNNING_TURN', 100);
    t.transition(2, 'TERMINAL', 200);
    const snap = t.heartbeatSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].agentRunId).toBe(1);
  });

  it('persistence failures do not propagate', () => {
    const failing: SupervisionPersistence = {
      loadAll: () => [],
      saveRecord: vi.fn(() => {
        throw new Error('disk full');
      }),
      saveHeartbeats: vi.fn(),
      deleteRecord: vi.fn(() => {
        throw new Error('locked');
      }),
      saveIncident: vi.fn(),
      listRecentIncidents: () => [],
    };
    const t = new HeartbeatTracker();
    t.setPersistence(failing);
    expect(() => t.register({ agentRunId: 1, companySessionId: 100, role: 'qa' })).not.toThrow();
    expect(() => t.unregister(1)).not.toThrow();
  });
});
