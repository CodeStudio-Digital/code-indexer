/**
 * Tests for AgentSupervisor singleton (Sprint 4 Phase 1.4).
 *
 * Locks in:
 *   - start/stop lifecycle + idempotent
 *   - tickOnce detects stuck agents + emits incidents
 *   - Dedup: same stuck agent doesn't fire incident on consecutive ticks
 *   - getStatus snapshot
 *   - register subordinate/master entry points
 *   - manual transition + illegal_transition path
 *   - startAgentSupervisorIfEnabled honors env flag
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentSupervisor,
  startAgentSupervisorIfEnabled,
  type AgentSupervisorDeps,
} from '../index.js';
import { CompanyEventBus } from '../../CompanyEventBus.js';
import { SubordinateCompletionBus } from '../../subordinate/completion-events.js';
import { DEFAULT_STATE_TIMEOUT_MS } from '../state-machine.js';

function makeDeps(over: Partial<AgentSupervisorDeps> = {}): AgentSupervisorDeps {
  return {
    companyEventBus: new CompanyEventBus(),
    completionBus: new SubordinateCompletionBus(),
    tickIntervalMs: 60_000, // long so tests don't fire it unless they call tickOnce
    ...over,
  };
}

describe('AgentSupervisor — lifecycle', () => {
  it('start() returns true on first call, false thereafter', () => {
    const sup = new AgentSupervisor(makeDeps());
    expect(sup.start()).toBe(true);
    expect(sup.start()).toBe(false);
    sup.stop();
  });

  it('stop() is idempotent', () => {
    const sup = new AgentSupervisor(makeDeps());
    sup.start();
    sup.stop();
    sup.stop(); // no throw
    expect(sup.getStatus().isRunning).toBe(false);
  });

  it('isRunning reflects start/stop', () => {
    const sup = new AgentSupervisor(makeDeps());
    expect(sup.getStatus().isRunning).toBe(false);
    sup.start();
    expect(sup.getStatus().isRunning).toBe(true);
    sup.stop();
    expect(sup.getStatus().isRunning).toBe(false);
  });
});

describe('AgentSupervisor — registration', () => {
  it('registerSubordinate adds to tracker', () => {
    const sup = new AgentSupervisor(makeDeps());
    sup.registerSubordinate({ agentRunId: 1, companySessionId: 100, role: 'frontend' });
    const status = sup.getStatus();
    expect(status.trackedCount).toBe(1);
    expect(status.byState.BOOTING).toBe(1);
  });

  it('registerMaster uses role=master', () => {
    const sup = new AgentSupervisor(makeDeps());
    sup.registerMaster({ agentRunId: 1, companySessionId: 100 });
    expect(sup.listRecords()[0].role).toBe('master');
  });
});

describe('AgentSupervisor — manual transitions', () => {
  it('applied legal transition returns true', () => {
    const sup = new AgentSupervisor(makeDeps());
    sup.registerSubordinate({ agentRunId: 1, companySessionId: 100, role: 'qa' });
    expect(sup.transition(1, 'RUNNING_TURN')).toBe(true);
    expect(sup.listRecords()[0].state).toBe('RUNNING_TURN');
  });

  it('illegal transition returns false + emits incident', () => {
    const incidents: unknown[] = [];
    const sup = new AgentSupervisor(makeDeps({ emitIncident: (i) => { incidents.push(i); } }));
    sup.registerSubordinate({ agentRunId: 1, companySessionId: 100, role: 'qa' });
    // BOOTING → AWAITING_TOOL is illegal
    expect(sup.transition(1, 'AWAITING_TOOL')).toBe(false);
    expect(incidents).toHaveLength(1);
    expect((incidents[0] as { kind: string }).kind).toBe('illegal_transition');
  });

  it('heartbeat bumps lastHeartbeatAt without state change', () => {
    const sup = new AgentSupervisor(makeDeps());
    sup.registerSubordinate({ agentRunId: 1, companySessionId: 100, role: 'qa' });
    sup.transition(1, 'RUNNING_TURN');
    const before = sup.listRecords()[0].lastHeartbeatAt;
    // Wait a tick of wall-clock
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        sup.heartbeat(1);
        const after = sup.listRecords()[0].lastHeartbeatAt;
        expect(after).toBeGreaterThan(before);
        resolve();
      }, 5);
    });
  });
});

describe('AgentSupervisor — tickOnce stuck detection', () => {
  it('detects RUNNING_TURN stuck after 5min', async () => {
    const incidents: unknown[] = [];
    const sup = new AgentSupervisor(
      makeDeps({ emitIncident: (i) => { incidents.push(i); } }),
    );
    sup.registerSubordinate({ agentRunId: 1, companySessionId: 100, role: 'frontend' });
    sup.transition(1, 'RUNNING_TURN');
    // Manually push the record's heartbeat back so it's stuck.
    const records = sup.listRecords();
    const r = records[0];
    // r is read-only by contract but in-process — mutate via tracker indirectly.
    // Easier: use a future nowMs argument.
    const future = Date.now() + DEFAULT_STATE_TIMEOUT_MS.RUNNING_TURN! + 1000;
    const stuck = await sup.tickOnce(future);
    expect(stuck).toHaveLength(1);
    expect(stuck[0].record.agentRunId).toBe(1);
    expect(stuck[0].toStuckState).toBe('STUCK_TURN');
    expect(incidents.length).toBeGreaterThan(0);
    // After detection, state is STUCK_TURN
    expect(sup.listRecords()[0].state).toBe('STUCK_TURN');
    void r;
  });

  it('dedup: same stuck agent does not re-fire incident on next tick', async () => {
    const incidents: unknown[] = [];
    const sup = new AgentSupervisor(
      makeDeps({ emitIncident: (i) => { incidents.push(i); } }),
    );
    sup.registerSubordinate({ agentRunId: 1, companySessionId: 100, role: 'qa' });
    sup.transition(1, 'RUNNING_TURN');
    const future = Date.now() + DEFAULT_STATE_TIMEOUT_MS.RUNNING_TURN! + 1000;
    await sup.tickOnce(future);
    const first = incidents.length;
    await sup.tickOnce(future + 30_000);
    const second = incidents.length;
    expect(second).toBe(first); // no new incident
  });

  it('detects AWAITING_TOOL stuck as STUCK_TOOL', async () => {
    const sup = new AgentSupervisor(makeDeps());
    sup.registerSubordinate({ agentRunId: 1, companySessionId: 100, role: 'qa' });
    sup.transition(1, 'RUNNING_TURN');
    sup.transition(1, 'AWAITING_TOOL', { toolUseId: 'tu-1', toolName: 'Bash' });
    const future = Date.now() + DEFAULT_STATE_TIMEOUT_MS.AWAITING_TOOL! + 1000;
    const stuck = await sup.tickOnce(future);
    expect(stuck[0].toStuckState).toBe('STUCK_TOOL');
  });

  it('skips IDLE agents (no timeout)', async () => {
    const sup = new AgentSupervisor(makeDeps());
    sup.registerSubordinate({ agentRunId: 1, companySessionId: 100, role: 'qa' });
    sup.transition(1, 'RUNNING_TURN');
    sup.transition(1, 'IDLE');
    const future = Date.now() + 24 * 60 * 60_000; // 24hr later
    const stuck = await sup.tickOnce(future);
    expect(stuck).toHaveLength(0);
  });

  it('skips TERMINAL agents', async () => {
    const sup = new AgentSupervisor(makeDeps());
    sup.registerSubordinate({ agentRunId: 1, companySessionId: 100, role: 'qa' });
    sup.transition(1, 'RUNNING_TURN');
    sup.transition(1, 'TERMINAL');
    const future = Date.now() + 24 * 60 * 60_000;
    expect(await sup.tickOnce(future)).toHaveLength(0);
  });

  it('first tick fires immediately on start (not after interval)', () => {
    const sup = new AgentSupervisor(makeDeps({ tickIntervalMs: 60_000 }));
    sup.start();
    expect(sup.getStatus().tickCount).toBeGreaterThanOrEqual(1);
    sup.stop();
  });
});

describe('AgentSupervisor — getStatus', () => {
  it('reports counts by state', () => {
    const sup = new AgentSupervisor(makeDeps());
    sup.registerSubordinate({ agentRunId: 1, companySessionId: 100, role: 'qa' });
    sup.registerSubordinate({ agentRunId: 2, companySessionId: 100, role: 'frontend' });
    sup.transition(1, 'RUNNING_TURN');
    // sup 2 stays in BOOTING
    const status = sup.getStatus();
    expect(status.trackedCount).toBe(2);
    expect(status.byState.RUNNING_TURN).toBe(1);
    expect(status.byState.BOOTING).toBe(1);
  });

  it('stuckCount reflects STUCK_* + FAILED_* + INBOX_EXPIRED states', async () => {
    const sup = new AgentSupervisor(makeDeps());
    sup.registerSubordinate({ agentRunId: 1, companySessionId: 100, role: 'qa' });
    sup.transition(1, 'RUNNING_TURN');
    const future = Date.now() + DEFAULT_STATE_TIMEOUT_MS.RUNNING_TURN! + 1000;
    await sup.tickOnce(future);
    expect(sup.getStatus().stuckCount).toBe(1);
  });
});

describe('startAgentSupervisorIfEnabled', () => {
  const originalEnv = process.env.MCP_SUPERVISOR_ENABLED;
  beforeEach(() => {
    delete process.env.MCP_SUPERVISOR_ENABLED;
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.MCP_SUPERVISOR_ENABLED;
    else process.env.MCP_SUPERVISOR_ENABLED = originalEnv;
  });

  it('returns null when env flag unset', () => {
    expect(startAgentSupervisorIfEnabled(makeDeps())).toBeNull();
  });

  it('creates + starts supervisor when env flag set to "1"', () => {
    process.env.MCP_SUPERVISOR_ENABLED = '1';
    const sup = startAgentSupervisorIfEnabled(makeDeps());
    expect(sup).toBeInstanceOf(AgentSupervisor);
    expect(sup?.getStatus().isRunning).toBe(true);
    sup?.stop();
  });

  it('returns null when env flag is anything other than "1"', () => {
    process.env.MCP_SUPERVISOR_ENABLED = 'true';
    expect(startAgentSupervisorIfEnabled(makeDeps())).toBeNull();
    process.env.MCP_SUPERVISOR_ENABLED = '0';
    expect(startAgentSupervisorIfEnabled(makeDeps())).toBeNull();
  });
});
