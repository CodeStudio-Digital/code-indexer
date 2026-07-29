/**
 * Tests for AgentSupervisor × Persistence wiring (Sprint 4 Phase 2.4).
 *
 * Locks in:
 *   - hydrateFromPersistence loads records into tracker
 *   - Ghost detection on hydrate emits stuck_detected incidents +
 *     transitions ghosts to TERMINAL
 *   - tickOnce flushes heartbeats via persistence.saveHeartbeats
 *   - Every emitted incident is mirrored to persistence.saveIncident
 *   - getStatus / listRecentIncidents bridges through persistence
 *   - Failures inside persistence don't crash the supervisor
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AgentSupervisor,
  type AgentSupervisionRecord,
  type AgentSupervisorDeps,
  type IncidentQueryRow,
  type PersistedIncident,
  type SupervisionPersistence,
} from '../index.js';
import { CompanyEventBus } from '../../CompanyEventBus.js';
import { SubordinateCompletionBus } from '../../subordinate/completion-events.js';
import { agentRunId, companySessionId } from './uuid-fixtures.js';

const SESSION_ID = companySessionId(100);
const AGENT_1 = agentRunId(1);
const AGENT_2 = agentRunId(2);

function makeRecord(over: Partial<AgentSupervisionRecord> = {}): AgentSupervisionRecord {
  return {
    agentRunId: AGENT_1,
    companySessionId: SESSION_ID,
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

/** In-memory persistence that captures interactions. */
class FakePersistence implements SupervisionPersistence {
  rows: AgentSupervisionRecord[] = [];
  incidents: PersistedIncident[] = [];
  heartbeatBatches: number[] = []; // batch sizes
  loadAllImpl: () => AgentSupervisionRecord[] = () => this.rows.map((r) => ({ ...r }));

  loadAll(): AgentSupervisionRecord[] {
    return this.loadAllImpl();
  }
  saveRecord(record: AgentSupervisionRecord): void {
    const idx = this.rows.findIndex((r) => r.agentRunId === record.agentRunId);
    if (idx >= 0) this.rows[idx] = { ...record };
    else this.rows.push({ ...record });
  }
  saveHeartbeats(records: ReadonlyArray<{ agentRunId: string; lastHeartbeatAt: number }>): void {
    this.heartbeatBatches.push(records.length);
  }
  deleteRecord(agentRunId: string): void {
    this.rows = this.rows.filter((r) => r.agentRunId !== agentRunId);
  }
  saveIncident(incident: PersistedIncident): void {
    this.incidents.push(incident);
  }
  listRecentIncidents(_sessionId: string, _limit: number): IncidentQueryRow[] {
    return this.incidents.map(
      (i, idx): IncidentQueryRow => ({
        ...i,
        id: agentRunId(500 + idx),
        resolvedAtMs: null,
      }),
    );
  }
}

function makeDeps(
  over: Partial<AgentSupervisorDeps> = {},
  emitted: Array<{ kind: string; detail: string }> = [],
): AgentSupervisorDeps {
  return {
    companySessionId: SESSION_ID,
    companyEventBus: new CompanyEventBus(),
    completionBus: new SubordinateCompletionBus(),
    tickIntervalMs: 60_000,
    emitIncident: (inc) => emitted.push({ kind: inc.kind, detail: inc.detail }),
    ...over,
  };
}

describe('hydrateFromPersistence', () => {
  it('loads records into the tracker', () => {
    const p = new FakePersistence();
    p.rows = [
      makeRecord({ agentRunId: AGENT_1, state: 'RUNNING_TURN', lastHeartbeatAt: Date.now() }),
      makeRecord({ agentRunId: AGENT_2, state: 'AWAITING_TOOL', lastHeartbeatAt: Date.now() }),
    ];
    const sup = new AgentSupervisor(makeDeps({ persistence: p }));
    const { rehydrated, ghosts } = sup.hydrateFromPersistence(Date.now());
    expect(rehydrated).toBe(2);
    expect(ghosts).toBe(0);
    expect(sup.getStatus().trackedCount).toBe(2);
  });

  it('detects ghost_running and transitions them to TERMINAL', () => {
    const p = new FakePersistence();
    const now = Date.now();
    p.rows = [
      makeRecord({
        agentRunId: AGENT_1,
        role: 'frontend',
        state: 'RUNNING_TURN',
        lastHeartbeatAt: now - 10 * 60_000, // 10min stale
      }),
      makeRecord({
        agentRunId: AGENT_2,
        role: 'qa',
        state: 'AWAITING_MASTER_APPROVAL',
        lastHeartbeatAt: now, // fresh — not ghost
      }),
    ];
    const emitted: Array<{ kind: string; detail: string }> = [];
    const sup = new AgentSupervisor(
      makeDeps(
        { persistence: p, ghostStaleThresholdMs: 60_000 /* 1min */ },
        emitted,
      ),
      // emitIncident is set via makeDeps above
    );
    const { rehydrated, ghosts } = sup.hydrateFromPersistence(now);
    expect(rehydrated).toBe(2);
    expect(ghosts).toBe(1);
    expect(sup.listRecords().find((r) => r.agentRunId === AGENT_1)?.state).toBe('TERMINAL');
    expect(sup.listRecords().find((r) => r.agentRunId === AGENT_2)?.state).toBe('AWAITING_MASTER_APPROVAL');
    expect(emitted.some((e) => e.detail.includes('ghost_running'))).toBe(true);
  });

  it('survives persistence.loadAll throwing', () => {
    const p = new FakePersistence();
    p.loadAllImpl = () => {
      throw new Error('boom');
    };
    const emitted: Array<{ kind: string; detail: string }> = [];
    const sup = new AgentSupervisor(makeDeps({ persistence: p }, emitted));
    const out = sup.hydrateFromPersistence();
    expect(out).toEqual({ rehydrated: 0, ghosts: 0 });
    expect(emitted.some((e) => e.kind === 'observation_error')).toBe(true);
  });

  it('returns 0/0 when no persistence wired', () => {
    const sup = new AgentSupervisor(makeDeps());
    expect(sup.hydrateFromPersistence()).toEqual({ rehydrated: 0, ghosts: 0 });
  });
});

describe('tickOnce heartbeat flush', () => {
  it('calls persistence.saveHeartbeats with current snapshot each tick', async () => {
    const p = new FakePersistence();
    const sup = new AgentSupervisor(makeDeps({ persistence: p }));
    sup.registerSubordinate({ agentRunId: AGENT_1, companySessionId: SESSION_ID, role: 'frontend' });
    sup.registerSubordinate({ agentRunId: AGENT_2, companySessionId: SESSION_ID, role: 'qa' });
    await sup.tickOnce(Date.now());
    expect(p.heartbeatBatches).toHaveLength(1);
    expect(p.heartbeatBatches[0]).toBe(2);
  });

  it('survives persistence.saveHeartbeats throwing', async () => {
    const p = new FakePersistence();
    p.saveHeartbeats = vi.fn(() => {
      throw new Error('locked');
    });
    const sup = new AgentSupervisor(makeDeps({ persistence: p }));
    sup.registerSubordinate({ agentRunId: AGENT_1, companySessionId: SESSION_ID, role: 'frontend' });
    await expect(sup.tickOnce(Date.now())).resolves.toBeDefined();
  });
});

describe('incident mirroring', () => {
  it('mirrors every emitted incident into persistence.saveIncident', () => {
    const p = new FakePersistence();
    const sup = new AgentSupervisor(makeDeps({ persistence: p }));
    sup.registerSubordinate({ agentRunId: AGENT_1, companySessionId: SESSION_ID, role: 'frontend' });
    // AWAITING_TOOL is NOT a legal successor of BOOTING — triggers
    // an `illegal_transition` incident which the supervisor mirrors.
    sup.transition(AGENT_1, 'AWAITING_TOOL');
    expect(p.incidents.length).toBeGreaterThan(0);
    const first = p.incidents[0];
    expect(first.incidentKind).toBe('illegal_transition');
    expect(first.companySessionId).toBe(SESSION_ID);
  });

  it('persists companySessionId (not null) for incidents with a null agentRunId', () => {
    // `observation_error` (like `role_quarantined` / `read_only_mode`)
    // carries agentRunId: null. Regression guard for the bug where
    // companySessionId was resolved via a per-agent tracker lookup that
    // returns null whenever agentRunId is null — silently dropping these
    // incidents from every session-scoped query forever. Triggering
    // hydrateFromPersistence's loadAll-throws path is the simplest way to
    // exercise a real agentRunId: null incident.
    const p = new FakePersistence();
    p.loadAllImpl = () => {
      throw new Error('boom');
    };
    const sup = new AgentSupervisor(makeDeps({ persistence: p }));
    sup.hydrateFromPersistence();
    expect(p.incidents).toHaveLength(1);
    expect(p.incidents[0].agentRunId).toBeNull();
    expect(p.incidents[0].companySessionId).toBe(SESSION_ID);
  });

  it('listRecentIncidents bridges to persistence', () => {
    const p = new FakePersistence();
    p.incidents.push({
      agentRunId: AGENT_1,
      companySessionId: SESSION_ID,
      incidentKind: 'stuck_detected',
      fromState: null,
      attemptedToState: null,
      detail: 'test',
      detectedAtMs: 0,
    });
    const sup = new AgentSupervisor(makeDeps({ persistence: p }));
    const incidents = sup.listRecentIncidents(SESSION_ID, 10);
    expect(incidents).toHaveLength(1);
    expect(incidents[0].detail).toBe('test');
  });

  it('returns empty when persistence not wired', () => {
    const sup = new AgentSupervisor(makeDeps());
    expect(sup.listRecentIncidents(SESSION_ID)).toEqual([]);
  });
});

describe('start() rehydrates only once', () => {
  it('hydrate fires on first start, not on subsequent', () => {
    const p = new FakePersistence();
    const loadSpy = vi.spyOn(p, 'loadAll');
    p.rows = [makeRecord({ agentRunId: AGENT_1, lastHeartbeatAt: Date.now() })];
    const sup = new AgentSupervisor(makeDeps({ persistence: p }));
    sup.start();
    sup.stop();
    sup.start();
    expect(loadSpy).toHaveBeenCalledTimes(1);
    sup.stop();
  });
});
