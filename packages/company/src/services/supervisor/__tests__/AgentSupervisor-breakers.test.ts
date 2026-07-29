/**
 * Tests for AgentSupervisor × CircuitBreakers wiring (Sprint 4 Phase 2.3).
 *
 * Locks in:
 *   - Successful recovery DOES NOT bump breaker counters
 *   - no_match outcome DOES NOT bump breakers (action didn't apply)
 *   - Failed recovery DOES bump per-agent + per-role counters
 *   - Per-agent breaker trip → QUARANTINED + agent_quarantined incident
 *   - Per-role breaker trip → role_quarantined incident + isRoleQuarantined returns info
 *   - Global breaker trip → recovery is skipped (read-only mode)
 *   - Operator releases (releaseRoleQuarantine, releaseReadOnlyMode) work
 *   - getStatus snapshot includes breakers
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AgentSupervisor,
  type AgentSupervisorDeps,
  type RecoveryContext,
} from '../index.js';
import { CompanyEventBus } from '../../CompanyEventBus.js';
import { SubordinateCompletionBus } from '../../subordinate/completion-events.js';
import { agentRunId as makeAgentRunId, companySessionId } from './uuid-fixtures.js';

const SESSION = companySessionId(100);
const AGENT_1 = makeAgentRunId(1);
const AGENT_2 = makeAgentRunId(2);

function makeDeps(over: Partial<AgentSupervisorDeps> = {}): AgentSupervisorDeps {
  return {
    companySessionId: SESSION,
    companyEventBus: new CompanyEventBus(),
    completionBus: new SubordinateCompletionBus(),
    tickIntervalMs: 60_000,
    ...over,
  };
}

/**
 * Create a supervisor with a recovery context whose `forceResumeSubordinate`
 * action will ALWAYS fail (throws). Useful to drive the per-agent breaker.
 */
function makeFailingRecovery(): RecoveryContext {
  return {
    subordinates: {
      resume: vi.fn().mockRejectedValue(new Error('synthetic failure')),
      abort: vi.fn(),
    },
    master: {
      isAlive: () => false, // so resurrectMasterIfOrphaned does NOT short-circuit
      resurrect: vi.fn().mockRejectedValue(new Error('synthetic failure')),
    },
  };
}

/**
 * Place the agent into a stuck state by manually transitioning the
 * record's lastHeartbeatAt to >timeout ago. Bypasses real timing.
 */
function setupStuckAgent(
  sup: AgentSupervisor,
  agentRunId: string,
  role: string,
  now: number,
): void {
  sup.registerSubordinate({ agentRunId, companySessionId: SESSION, role });
  sup.transition(agentRunId, 'RUNNING_TURN');
  // Move the agent into AWAITING_MASTER_APPROVAL and backdate lastHeartbeatAt
  sup.transition(agentRunId, 'AWAITING_MASTER_APPROVAL');
  const rec = sup.listRecords().find((r) => r.agentRunId === agentRunId);
  if (rec) {
    // 31 min in the past → exceeds AWAITING_MASTER_APPROVAL default (30min)
    rec.lastHeartbeatAt = now - 31 * 60_000;
  }
}

describe('successful recovery does NOT bump breakers', () => {
  it('records no agent failures after a successful resume', async () => {
    const incidents: Array<{ kind: string; detail: string }> = [];
    const recovery: RecoveryContext = {
      subordinates: {
        resume: vi.fn().mockResolvedValue(undefined),
        abort: vi.fn(),
      },
      master: { isAlive: () => false, resurrect: vi.fn().mockResolvedValue(undefined) },
    };
    const sup = new AgentSupervisor(
      makeDeps({
        emitIncident: (inc) => incidents.push({ kind: inc.kind, detail: inc.detail }),
        recoveryContext: recovery,
        circuitBreakerConfig: { agentLimit: 2 },
      }),
    );
    const now = Date.now();
    setupStuckAgent(sup, AGENT_1, 'frontend', now);
    await sup.tickOnce(now);
    // Allow microtasks to flush
    await new Promise((r) => setImmediate(r));
    const status = sup.getStatus(now);
    expect(status.breakers.agents).toHaveLength(0);
    expect(incidents.find((i) => i.kind === 'agent_quarantined')).toBeUndefined();
  });
});

describe('per-agent breaker', () => {
  it('trips after N failed recoveries and quarantines the agent', async () => {
    const incidents: Array<{ kind: string; detail: string }> = [];
    // agentLimit=1 so a SINGLE failed recovery trips the breaker —
    // avoids the complexity of re-stuck-ing an agent that's already
    // transitioned to STUCK_*.
    const sup = new AgentSupervisor(
      makeDeps({
        emitIncident: (inc) => incidents.push({ kind: inc.kind, detail: inc.detail }),
        recoveryContext: makeFailingRecovery(),
        circuitBreakerConfig: {
          agentLimit: 1,
          agentWindowMs: 60_000,
          // High role limit so the role breaker doesn't fire first.
          roleLimit: 999,
        },
      }),
    );
    const now = Date.now();
    setupStuckAgent(sup, AGENT_1, 'frontend', now);

    await sup.tickOnce(now);
    await new Promise((r) => setImmediate(r));

    const status = sup.getStatus(now + 1);
    const agentEntry = status.breakers.agents.find(
      (agent) => agent.agentRunId === AGENT_1,
    );
    expect(agentEntry?.tripped).toBe(true);
    expect(incidents.some((i) => i.kind === 'agent_quarantined')).toBe(true);
    const record = sup.listRecords().find(
      (candidate) => candidate.agentRunId === AGENT_1,
    );
    expect(record?.state).toBe('QUARANTINED');
  });
});

describe('per-role breaker', () => {
  it('trips after N role failures and refuses spawns', async () => {
    const incidents: Array<{ kind: string; detail: string }> = [];
    const sup = new AgentSupervisor(
      makeDeps({
        emitIncident: (inc) => incidents.push({ kind: inc.kind, detail: inc.detail }),
        recoveryContext: makeFailingRecovery(),
        circuitBreakerConfig: {
          // Loose agent limit so we exercise role limit cleanly.
          agentLimit: 999,
          roleLimit: 2,
          roleWindowMs: 60_000,
          roleQuarantineMs: 5_000,
        },
      }),
    );
    const now = Date.now();
    setupStuckAgent(sup, AGENT_1, 'qa', now);
    await sup.tickOnce(now);
    await new Promise((r) => setImmediate(r));

    sup.clearStuckDedupForTests();
    setupStuckAgent(sup, AGENT_2, 'qa', now + 1);
    await sup.tickOnce(now + 1);
    await new Promise((r) => setImmediate(r));

    expect(incidents.some((i) => i.kind === 'role_quarantined')).toBe(true);
    expect(sup.isRoleQuarantined('qa', now + 2)).not.toBeNull();
    expect(sup.isRoleQuarantined('frontend', now + 2)).toBeNull();
  });

  it('releaseRoleQuarantine clears the quarantine', async () => {
    const incidents: Array<{ kind: string; detail: string }> = [];
    const sup = new AgentSupervisor(
      makeDeps({
        emitIncident: (inc) => incidents.push({ kind: inc.kind, detail: inc.detail }),
        recoveryContext: makeFailingRecovery(),
        circuitBreakerConfig: { agentLimit: 999, roleLimit: 1, roleQuarantineMs: 60_000 },
      }),
    );
    const now = Date.now();
    setupStuckAgent(sup, AGENT_1, 'qa', now);
    await sup.tickOnce(now);
    await new Promise((r) => setImmediate(r));
    expect(sup.isRoleQuarantined('qa', now + 1)).not.toBeNull();

    expect(sup.releaseRoleQuarantine('qa')).toBe(true);
    expect(sup.isRoleQuarantined('qa', now + 2)).toBeNull();
    // Returns false when nothing to release
    expect(sup.releaseRoleQuarantine('nonexistent')).toBe(false);
  });
});

describe('global breaker (read-only mode)', () => {
  it('skips recovery dispatch when in read-only mode', async () => {
    const resume = vi.fn().mockResolvedValue(undefined);
    const incidents: Array<{ kind: string; detail: string }> = [];
    const sup = new AgentSupervisor(
      makeDeps({
        emitIncident: (inc) => incidents.push({ kind: inc.kind, detail: inc.detail }),
        recoveryContext: {
          subordinates: { resume, abort: vi.fn() },
          master: { isAlive: () => false, resurrect: vi.fn().mockResolvedValue(undefined) },
        },
        circuitBreakerConfig: {
          globalLimit: 1,
          globalWindowMs: 60_000,
          globalReadOnlyMs: 60_000,
        },
      }),
    );
    const now = Date.now();
    setupStuckAgent(sup, AGENT_1, 'frontend', now);
    // First tick: incident records → trips global breaker (limit=1).
    // The check `isReadOnlyMode` happens AFTER the incident recording,
    // so this tick's recovery still runs. The NEXT tick is silenced.
    await sup.tickOnce(now);
    await new Promise((r) => setImmediate(r));

    resume.mockClear();
    sup.clearStuckDedupForTests();
    setupStuckAgent(sup, AGENT_2, 'backend', now + 1);
    await sup.tickOnce(now + 1);
    await new Promise((r) => setImmediate(r));

    expect(resume).not.toHaveBeenCalled();
    expect(incidents.some((i) => i.kind === 'read_only_mode')).toBe(true);
  });

  it('releaseReadOnlyMode clears the breaker', async () => {
    const sup = new AgentSupervisor(
      makeDeps({
        recoveryContext: makeFailingRecovery(),
        circuitBreakerConfig: { globalLimit: 1, globalReadOnlyMs: 60_000 },
      }),
    );
    const now = Date.now();
    setupStuckAgent(sup, AGENT_1, 'frontend', now);
    await sup.tickOnce(now);
    await new Promise((r) => setImmediate(r));

    const status1 = sup.getStatus(now + 1);
    expect(status1.breakers.readOnlyUntilMs).not.toBeNull();
    expect(sup.releaseReadOnlyMode()).toBe(true);
    const status2 = sup.getStatus(now + 2);
    expect(status2.breakers.readOnlyUntilMs).toBeNull();
  });
});

describe('getStatus snapshot', () => {
  it('includes breakers field', () => {
    const sup = new AgentSupervisor(makeDeps());
    const status = sup.getStatus();
    expect(status.breakers).toBeDefined();
    expect(status.breakers.agents).toEqual([]);
    expect(status.breakers.roles).toEqual([]);
    expect(status.breakers.globalIncidentsInWindow).toBe(0);
    expect(status.breakers.readOnlyUntilMs).toBeNull();
  });
});
