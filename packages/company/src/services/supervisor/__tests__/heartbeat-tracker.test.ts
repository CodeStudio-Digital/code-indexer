/**
 * Tests for HeartbeatTracker (Sprint 4 Phase 1.2).
 *
 * Locks in:
 *   - register() is idempotent
 *   - heartbeat() bumps lastHeartbeatAt without changing state
 *   - transition() validates against legal table
 *   - transition() rejects from TERMINAL (sink)
 *   - transition() updates enteredAt only on actual state change
 *   - AWAITING_TOOL captures tool context; other states clear it
 *   - detectStuck() finds agents whose heartbeat is older than the state timeout
 *   - detectStuck() skips already-stuck/terminal/no-timeout states
 *   - incident + recoveryAttempts counters
 */
import { describe, expect, it } from 'vitest';
import { HeartbeatTracker } from '../heartbeat-tracker.js';
import { DEFAULT_STATE_TIMEOUT_MS } from '../state-machine.js';
import { agentRunId, companySessionId } from './uuid-fixtures.js';

const AGENT_1 = agentRunId(1);
const AGENT_2 = agentRunId(2);
const UNKNOWN_AGENT = agentRunId(999);
const baseArgs = {
  agentRunId: AGENT_1,
  companySessionId: companySessionId(100),
  role: 'frontend',
};

describe('HeartbeatTracker — register', () => {
  it('creates a new record in BOOTING state', () => {
    const t = new HeartbeatTracker();
    const r = t.register(baseArgs, 1000);
    expect(r.state).toBe('BOOTING');
    expect(r.enteredAt).toBe(1000);
    expect(r.lastHeartbeatAt).toBe(1000);
    expect(r.incidentCount).toBe(0);
    expect(r.recoveryAttempts).toBe(0);
    expect(r.currentToolUseId).toBeNull();
  });

  it('is idempotent — calling twice returns the same record without resetting state', () => {
    const t = new HeartbeatTracker();
    const r1 = t.register(baseArgs, 1000);
    t.transition(AGENT_1, 'RUNNING_TURN', 2000);
    const r2 = t.register(baseArgs, 9999);
    expect(r2).toBe(r1);
    expect(r2.state).toBe('RUNNING_TURN'); // not reset to BOOTING
    expect(r2.enteredAt).toBe(2000); // preserved
  });

  it('size() reflects registered count', () => {
    const t = new HeartbeatTracker();
    expect(t.size()).toBe(0);
    t.register(baseArgs);
    t.register({ ...baseArgs, agentRunId: AGENT_2 });
    expect(t.size()).toBe(2);
  });
});

describe('HeartbeatTracker — heartbeat', () => {
  it('bumps lastHeartbeatAt without changing state', () => {
    const t = new HeartbeatTracker();
    t.register(baseArgs, 1000);
    t.transition(AGENT_1, 'RUNNING_TURN', 2000);
    t.heartbeat(AGENT_1, 5000);
    const r = t.get(AGENT_1)!;
    expect(r.lastHeartbeatAt).toBe(5000);
    expect(r.state).toBe('RUNNING_TURN');
    expect(r.enteredAt).toBe(2000); // unchanged
  });

  it('returns false for unknown agent', () => {
    const t = new HeartbeatTracker();
    expect(t.heartbeat(UNKNOWN_AGENT)).toBe(false);
  });
});

describe('HeartbeatTracker — transition', () => {
  it('applies legal transition', () => {
    const t = new HeartbeatTracker();
    t.register(baseArgs, 1000);
    const res = t.transition(AGENT_1, 'RUNNING_TURN', 2000);
    expect(res.applied).toBe(true);
    expect(res.from).toBe('BOOTING');
    expect(res.to).toBe('RUNNING_TURN');
    expect(t.get(AGENT_1)?.enteredAt).toBe(2000);
  });

  it('rejects illegal transition with reason illegal_transition', () => {
    const t = new HeartbeatTracker();
    t.register(baseArgs, 1000);
    // BOOTING → AWAITING_TOOL is illegal (must go through RUNNING_TURN)
    const res = t.transition(AGENT_1, 'AWAITING_TOOL', 2000);
    expect(res.applied).toBe(false);
    expect(res.reason).toBe('illegal_transition');
    expect(t.get(AGENT_1)?.state).toBe('BOOTING'); // unchanged
  });

  it('rejects transition for unknown agent', () => {
    const t = new HeartbeatTracker();
    const res = t.transition(UNKNOWN_AGENT, 'RUNNING_TURN');
    expect(res.applied).toBe(false);
    expect(res.reason).toBe('unknown_agent');
  });

  it('TERMINAL is a sink — rejects further transitions', () => {
    const t = new HeartbeatTracker();
    t.register(baseArgs, 1000);
    t.transition(AGENT_1, 'RUNNING_TURN', 1500);
    t.transition(AGENT_1, 'TERMINAL', 2000);
    const res = t.transition(AGENT_1, 'RUNNING_TURN', 3000);
    expect(res.applied).toBe(false);
    expect(res.reason).toBe('terminal_sink');
    expect(t.get(AGENT_1)?.state).toBe('TERMINAL');
  });

  it('same-state transition (heartbeat refresh) is applied without changing enteredAt', () => {
    const t = new HeartbeatTracker();
    t.register(baseArgs, 1000);
    t.transition(AGENT_1, 'RUNNING_TURN', 2000);
    const res = t.transition(AGENT_1, 'RUNNING_TURN', 5000);
    expect(res.applied).toBe(true);
    expect(t.get(AGENT_1)?.enteredAt).toBe(2000); // unchanged
    expect(t.get(AGENT_1)?.lastHeartbeatAt).toBe(5000);
  });

  it('AWAITING_TOOL captures tool context', () => {
    const t = new HeartbeatTracker();
    t.register(baseArgs, 1000);
    t.transition(AGENT_1, 'RUNNING_TURN', 1500);
    t.transition(AGENT_1, 'AWAITING_TOOL', 2000, { toolUseId: 'tu-42', toolName: 'Read' });
    const r = t.get(AGENT_1)!;
    expect(r.currentToolUseId).toBe('tu-42');
    expect(r.currentToolName).toBe('Read');
  });

  it('transitioning OUT of AWAITING_TOOL clears the tool context', () => {
    const t = new HeartbeatTracker();
    t.register(baseArgs, 1000);
    t.transition(AGENT_1, 'RUNNING_TURN', 1500);
    t.transition(AGENT_1, 'AWAITING_TOOL', 2000, { toolUseId: 'tu-42', toolName: 'Read' });
    t.transition(AGENT_1, 'RUNNING_TURN', 3000);
    const r = t.get(AGENT_1)!;
    expect(r.currentToolUseId).toBeNull();
    expect(r.currentToolName).toBeNull();
  });
});

describe('HeartbeatTracker — incident + recovery counters', () => {
  it('recordIncident increments counter', () => {
    const t = new HeartbeatTracker();
    t.register(baseArgs);
    expect(t.recordIncident(AGENT_1)).toBe(1);
    expect(t.recordIncident(AGENT_1)).toBe(2);
    expect(t.get(AGENT_1)?.incidentCount).toBe(2);
  });

  it('recordRecoveryAttempt increments counter', () => {
    const t = new HeartbeatTracker();
    t.register(baseArgs);
    expect(t.recordRecoveryAttempt(AGENT_1)).toBe(1);
    expect(t.recordRecoveryAttempt(AGENT_1)).toBe(2);
  });

  it('returns 0 for unknown agent (graceful)', () => {
    const t = new HeartbeatTracker();
    expect(t.recordIncident(UNKNOWN_AGENT)).toBe(0);
    expect(t.recordRecoveryAttempt(UNKNOWN_AGENT)).toBe(0);
  });
});

describe('HeartbeatTracker — detectStuck', () => {
  it('finds RUNNING_TURN agent older than 5min', () => {
    const t = new HeartbeatTracker();
    t.register(baseArgs, 0);
    t.transition(AGENT_1, 'RUNNING_TURN', 0);
    const sixMin = DEFAULT_STATE_TIMEOUT_MS.RUNNING_TURN! + 1;
    const stuck = t.detectStuck(sixMin + 1);
    expect(stuck).toHaveLength(1);
    expect(stuck[0].fromState).toBe('RUNNING_TURN');
    expect(stuck[0].toStuckState).toBe('STUCK_TURN');
    expect(stuck[0].ageMs).toBeGreaterThan(DEFAULT_STATE_TIMEOUT_MS.RUNNING_TURN!);
  });

  it('finds AWAITING_TOOL agent older than 5min as STUCK_TOOL', () => {
    const t = new HeartbeatTracker();
    t.register(baseArgs, 0);
    t.transition(AGENT_1, 'RUNNING_TURN', 0);
    t.transition(AGENT_1, 'AWAITING_TOOL', 0, { toolUseId: 'tu', toolName: 'Bash' });
    const stuck = t.detectStuck(DEFAULT_STATE_TIMEOUT_MS.AWAITING_TOOL! + 1);
    expect(stuck).toHaveLength(1);
    expect(stuck[0].toStuckState).toBe('STUCK_TOOL');
  });

  it('honors stateTimeoutMsOverride', () => {
    const t = new HeartbeatTracker();
    t.register(baseArgs, 0);
    t.transition(AGENT_1, 'RUNNING_TURN', 0);
    const r = t.get(AGENT_1)!;
    r.stateTimeoutMsOverride = 1000;
    const stuck = t.detectStuck(2000);
    expect(stuck).toHaveLength(1);
  });

  it('skips IDLE (no timeout) and TERMINAL (sink)', () => {
    const t = new HeartbeatTracker();
    t.register({ ...baseArgs, agentRunId: AGENT_1 }, 0);
    t.transition(AGENT_1, 'RUNNING_TURN', 0);
    t.transition(AGENT_1, 'IDLE', 0);

    t.register({ ...baseArgs, agentRunId: AGENT_2 }, 0);
    t.transition(AGENT_2, 'RUNNING_TURN', 0);
    t.transition(AGENT_2, 'TERMINAL', 0);

    const stuck = t.detectStuck(60 * 60_000); // 1hr later
    expect(stuck).toHaveLength(0);
  });

  it('skips already-stuck agents (no re-detection)', () => {
    const t = new HeartbeatTracker();
    t.register(baseArgs, 0);
    t.transition(AGENT_1, 'RUNNING_TURN', 0);
    t.transition(AGENT_1, 'STUCK_TURN', DEFAULT_STATE_TIMEOUT_MS.RUNNING_TURN! + 1);
    const stuck = t.detectStuck(60 * 60_000);
    expect(stuck).toHaveLength(0);
  });

  it('heartbeat resets the stuck clock', () => {
    const t = new HeartbeatTracker();
    t.register(baseArgs, 0);
    t.transition(AGENT_1, 'RUNNING_TURN', 0);
    // Half-way through timeout, send a heartbeat:
    t.heartbeat(AGENT_1, DEFAULT_STATE_TIMEOUT_MS.RUNNING_TURN! / 2);
    // Now even at the OLD deadline, age is below threshold:
    const stuck = t.detectStuck(DEFAULT_STATE_TIMEOUT_MS.RUNNING_TURN! + 100);
    expect(stuck).toHaveLength(0);
  });
});

describe('HeartbeatTracker — unregister', () => {
  it('removes the record', () => {
    const t = new HeartbeatTracker();
    t.register(baseArgs);
    expect(t.unregister(AGENT_1)).toBe(true);
    expect(t.get(AGENT_1)).toBeNull();
    expect(t.size()).toBe(0);
  });

  it('returns false when nothing to remove', () => {
    const t = new HeartbeatTracker();
    expect(t.unregister(UNKNOWN_AGENT)).toBe(false);
  });
});
