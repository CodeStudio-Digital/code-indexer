/**
 * Tests for AgentSupervisor recovery actions (Sprint 4 Phase 2.2).
 *
 * Locks in:
 *   - abortStuckTool only fires when state=STUCK_TOOL + has runner ref
 *   - abortStuckTool calls injectToolResultError when available; falls back to abort()
 *   - forceResumeSubordinate skips when master is alive (defers)
 *   - resurrectMasterIfOrphaned skips when master is alive
 *   - resurrectMasterIfOrphaned skips when agent is master itself (no self-recovery)
 *   - dispatcher tries actions in registered order, returns first ok
 *   - dispatcher returns null when no actions registered for state
 */
import { describe, expect, it, vi } from 'vitest';
import {
  abortStuckTool,
  dispatchRecovery,
  forceResumeSubordinate,
  resurrectMasterIfOrphaned,
  listRegisteredActions,
  type RecoveryContext,
} from '../recovery-actions.js';
import type { AgentSupervisionRecord, StuckAgent } from '../heartbeat-tracker.js';
import type { SupervisionState } from '../state-machine.js';

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

function makeStuck(
  toStuckState: SupervisionState,
  fromState: SupervisionState,
  recordOver: Partial<AgentSupervisionRecord> = {},
): StuckAgent {
  return {
    record: makeRecord({ state: toStuckState, ...recordOver }),
    fromState,
    toStuckState,
    ageMs: 5 * 60_000,
  };
}

describe('abortStuckTool', () => {
  it('returns no_match when state is not STUCK_TOOL', async () => {
    const stuck = makeStuck('STUCK_TURN', 'RUNNING_TURN');
    const out = await abortStuckTool(stuck, {});
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('no_match');
  });

  it('returns skipped when currentToolUseId is missing', async () => {
    const stuck = makeStuck('STUCK_TOOL', 'AWAITING_TOOL', { currentToolUseId: null });
    const out = await abortStuckTool(stuck, {});
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('skipped');
  });

  it('returns skipped when no runner ref for the agent', async () => {
    const stuck = makeStuck('STUCK_TOOL', 'AWAITING_TOOL', {
      currentToolUseId: 'tu-1',
      currentToolName: 'Bash',
    });
    const out = await abortStuckTool(stuck, { runners: new Map() });
    expect(out.ok).toBe(false);
  });

  it('injects tool_result error when injectToolResultError is available', async () => {
    // Returns true → a matching in-flight call was found and unwedged.
    const inject = vi.fn().mockReturnValue(true);
    const ctx: RecoveryContext = {
      runners: new Map([
        [1, { injectToolResultError: inject, abort: vi.fn() }],
      ]),
    };
    const stuck = makeStuck('STUCK_TOOL', 'AWAITING_TOOL', {
      currentToolUseId: 'tu-1',
      currentToolName: 'Bash',
    });
    const out = await abortStuckTool(stuck, ctx);
    expect(out.ok).toBe(true);
    expect(inject).toHaveBeenCalledWith('tu-1', expect.stringContaining('Bash'));
    if (out.ok) expect(out.detail).toContain('tu-1');
  });

  it('falls back to abort when inject returns false (no in-flight call)', async () => {
    const inject = vi.fn().mockReturnValue(false);
    const abort = vi.fn();
    const ctx: RecoveryContext = {
      runners: new Map([[1, { injectToolResultError: inject, abort }]]),
    };
    const stuck = makeStuck('STUCK_TOOL', 'AWAITING_TOOL', {
      currentToolUseId: 'tu-1',
      currentToolName: 'Bash',
    });
    const out = await abortStuckTool(stuck, ctx);
    expect(out.ok).toBe(true);
    expect(inject).toHaveBeenCalled();
    expect(abort).toHaveBeenCalled();
  });

  it('falls back to runner.abort() when injectToolResultError missing', async () => {
    const abort = vi.fn();
    const ctx: RecoveryContext = {
      runners: new Map([[1, { abort }]]),
    };
    const stuck = makeStuck('STUCK_TOOL', 'AWAITING_TOOL', {
      currentToolUseId: 'tu-1',
      currentToolName: 'Bash',
    });
    const out = await abortStuckTool(stuck, ctx);
    expect(out.ok).toBe(true);
    expect(abort).toHaveBeenCalled();
    if (out.ok) expect(out.detail).toContain('fallback');
  });

  it('returns failed when injection throws', async () => {
    const ctx: RecoveryContext = {
      runners: new Map([
        [1, {
          injectToolResultError: () => { throw new Error('boom'); },
          abort: vi.fn(),
        }],
      ]),
    };
    const stuck = makeStuck('STUCK_TOOL', 'AWAITING_TOOL', {
      currentToolUseId: 'tu-1',
      currentToolName: 'Bash',
    });
    const out = await abortStuckTool(stuck, ctx);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe('failed');
      expect(out.detail).toContain('boom');
    }
  });
});

describe('forceResumeSubordinate', () => {
  it('returns no_match when state is not STUCK_AWAITING_MASTER', async () => {
    const stuck = makeStuck('STUCK_TURN', 'RUNNING_TURN');
    const out = await forceResumeSubordinate(stuck, {});
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('no_match');
  });

  it('returns skipped when subordinates handle missing', async () => {
    const stuck = makeStuck('STUCK_AWAITING_MASTER', 'AWAITING_MASTER_APPROVAL');
    const out = await forceResumeSubordinate(stuck, {});
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('skipped');
  });

  it('skips when master is alive (defers)', async () => {
    const resume = vi.fn();
    const ctx: RecoveryContext = {
      subordinates: { resume, abort: vi.fn() },
      master: { isAlive: () => true, resurrect: vi.fn() },
    };
    const stuck = makeStuck('STUCK_AWAITING_MASTER', 'AWAITING_MASTER_APPROVAL');
    const out = await forceResumeSubordinate(stuck, ctx);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('skipped');
    expect(resume).not.toHaveBeenCalled();
  });

  it('resumes when master is dead', async () => {
    const resume = vi.fn().mockResolvedValue(undefined);
    const ctx: RecoveryContext = {
      subordinates: { resume, abort: vi.fn() },
      master: { isAlive: () => false, resurrect: vi.fn() },
    };
    const stuck = makeStuck('STUCK_AWAITING_MASTER', 'AWAITING_MASTER_APPROVAL');
    const out = await forceResumeSubordinate(stuck, ctx);
    expect(out.ok).toBe(true);
    expect(resume).toHaveBeenCalledWith(1, expect.stringContaining('[SYSTEM]'));
  });

  it('resumes when no master handle provided (treats as dead)', async () => {
    const resume = vi.fn().mockResolvedValue(undefined);
    const ctx: RecoveryContext = {
      subordinates: { resume, abort: vi.fn() },
    };
    const stuck = makeStuck('STUCK_AWAITING_MASTER', 'AWAITING_MASTER_APPROVAL');
    const out = await forceResumeSubordinate(stuck, ctx);
    expect(out.ok).toBe(true);
  });
});

describe('resurrectMasterIfOrphaned', () => {
  it('returns no_match when agent is master itself', async () => {
    const stuck = makeStuck('STUCK_AWAITING_MASTER', 'AWAITING_MASTER_APPROVAL', {
      role: 'master',
    });
    const out = await resurrectMasterIfOrphaned(stuck, {});
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('no_match');
  });

  it('returns skipped when master handle missing', async () => {
    const stuck = makeStuck('STUCK_AWAITING_MASTER', 'AWAITING_MASTER_APPROVAL');
    const out = await resurrectMasterIfOrphaned(stuck, {});
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('skipped');
  });

  it('skips when master is already alive', async () => {
    const resurrect = vi.fn();
    const ctx: RecoveryContext = {
      master: { isAlive: () => true, resurrect },
    };
    const stuck = makeStuck('STUCK_AWAITING_MASTER', 'AWAITING_MASTER_APPROVAL');
    const out = await resurrectMasterIfOrphaned(stuck, ctx);
    expect(out.ok).toBe(false);
    expect(resurrect).not.toHaveBeenCalled();
  });

  it('resurrects when master is dead and agent is a subordinate', async () => {
    const resurrect = vi.fn().mockResolvedValue(undefined);
    const ctx: RecoveryContext = {
      master: { isAlive: () => false, resurrect },
    };
    const stuck = makeStuck('STUCK_AWAITING_MASTER', 'AWAITING_MASTER_APPROVAL', {
      role: 'frontend',
    });
    const out = await resurrectMasterIfOrphaned(stuck, ctx);
    expect(out.ok).toBe(true);
    expect(resurrect).toHaveBeenCalledWith(expect.stringContaining('frontend'));
  });
});

describe('dispatchRecovery', () => {
  it('returns null when no action registered for state', async () => {
    // STUCK_TURN has no action in Phase 2.2 (no_match for all 3 actions)
    const stuck = makeStuck('STUCK_TURN', 'RUNNING_TURN');
    const out = await dispatchRecovery(stuck, {});
    expect(out).toBeNull();
  });

  it('STUCK_TOOL → abortStuckTool', async () => {
    const inject = vi.fn();
    const ctx: RecoveryContext = {
      runners: new Map([[1, { injectToolResultError: inject, abort: vi.fn() }]]),
    };
    const stuck = makeStuck('STUCK_TOOL', 'AWAITING_TOOL', {
      currentToolUseId: 'tu-1',
      currentToolName: 'Bash',
    });
    const out = await dispatchRecovery(stuck, ctx);
    expect(out?.ok).toBe(true);
    expect(out?.action).toBe('abortStuckTool');
  });

  it('STUCK_AWAITING_MASTER → tries resurrectMaster first, then forceResume', async () => {
    const resurrect = vi.fn().mockResolvedValue(undefined);
    const ctx: RecoveryContext = {
      master: { isAlive: () => false, resurrect },
      subordinates: { resume: vi.fn(), abort: vi.fn() },
    };
    const stuck = makeStuck('STUCK_AWAITING_MASTER', 'AWAITING_MASTER_APPROVAL');
    const out = await dispatchRecovery(stuck, ctx);
    expect(out?.ok).toBe(true);
    expect(out?.action).toBe('resurrectMasterIfOrphaned');
    expect(resurrect).toHaveBeenCalled();
  });

  it('falls back to forceResumeSubordinate when resurrectMaster is no-op (no handle)', async () => {
    const resume = vi.fn().mockResolvedValue(undefined);
    const ctx: RecoveryContext = {
      subordinates: { resume, abort: vi.fn() },
      // No master → resurrectMaster returns skipped → falls through
    };
    const stuck = makeStuck('STUCK_AWAITING_MASTER', 'AWAITING_MASTER_APPROVAL');
    const out = await dispatchRecovery(stuck, ctx);
    expect(out?.ok).toBe(true);
    expect(out?.action).toBe('forceResumeSubordinate');
    expect(resume).toHaveBeenCalled();
  });
});

describe('listRegisteredActions', () => {
  it('exposes the actions-by-state map', () => {
    const reg = listRegisteredActions();
    expect(reg.STUCK_TOOL).toContain('abortStuckTool');
    expect(reg.STUCK_AWAITING_MASTER).toEqual(
      expect.arrayContaining(['resurrectMasterIfOrphaned', 'forceResumeSubordinate']),
    );
  });
});
