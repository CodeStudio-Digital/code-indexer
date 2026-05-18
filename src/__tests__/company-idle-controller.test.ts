import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  IdleController,
  type IdleControllerDeps,
} from '@mcp/company/services/IdleController.js';

/**
 * Mock environment for IdleController. The service depends on small
 * ports (publisher / subordinate query / context-like methods) — we
 * stub each with the minimal surface IdleController actually touches.
 */
interface Harness {
  controller: IdleController;
  publish: ReturnType<typeof vi.fn>;
  markEnded: ReturnType<typeof vi.fn>;
  updateStatus: ReturnType<typeof vi.fn>;
  onAutoContinue: ReturnType<typeof vi.fn>;
  consumeMasterShouldContinue: ReturnType<typeof vi.fn>;
  state: {
    aborted: boolean;
    busEnded: boolean;
    runningCount: number;
    hasEnded: boolean;
    endedWithError: string | null;
  };
}

function makeHarness(overrides: Partial<Harness['state']> = {}): Harness {
  const state = {
    aborted: false,
    busEnded: false,
    runningCount: 0,
    hasEnded: true,
    endedWithError: null as string | null,
    ...overrides,
  };
  const publish = vi.fn();
  const markEnded = vi.fn();
  const updateStatus = vi.fn();
  const onAutoContinue = vi.fn();
  const consumeMasterShouldContinue = vi.fn(() => false);

  const deps: IdleControllerDeps = {
    ctx: {
      companySessionId: 42,
      // The controller only reads three fields off the context.
      get isAborted() { return state.aborted; },
      get isBusEnded() { return state.busEnded; },
      companyStore: { updateCompanySessionStatus: updateStatus } as never,
    } as never,
    bus: { publish, markEnded } as never,
    subordinates: {
      get runningCount() { return state.runningCount; },
      isRunning: () => false,
    } as never,
    onAutoContinue,
    consumeMasterShouldContinue,
    master: {
      get hasEnded() { return state.hasEnded; },
      get endedWithError() { return state.endedWithError; },
    },
  };
  return {
    controller: new IdleController(deps),
    publish,
    markEnded,
    updateStatus,
    onAutoContinue,
    consumeMasterShouldContinue,
    state,
  };
}

describe('IdleController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.CODER_COMPANY_IDLE_TIMEOUT_MS = '60000'; // 60s — well above any test
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.CODER_COMPANY_IDLE_TIMEOUT_MS;
  });

  it('publishes session_idle with waiting_for_input when master ends cleanly', () => {
    const h = makeHarness({ hasEnded: true, runningCount: 0 });
    h.controller.onMasterEnded();
    expect(h.publish).toHaveBeenCalledWith('session_idle', {
      reason: 'waiting_for_input',
    });
    expect(h.updateStatus).toHaveBeenCalledWith(42, 'paused');
  });

  it('reports master_error reason when the master ended with an error', () => {
    const h = makeHarness({
      hasEnded: true,
      runningCount: 0,
      endedWithError: 'provider timeout',
    });
    h.controller.onMasterEnded();
    expect(h.publish).toHaveBeenCalledWith('session_idle', {
      reason: 'master_error',
      errorDetail: 'provider timeout',
    });
  });

  it('does nothing while subordinates are still running', () => {
    const h = makeHarness({ hasEnded: true, runningCount: 2 });
    h.controller.onMasterEnded();
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.updateStatus).not.toHaveBeenCalled();
  });

  it('does nothing if the master has not ended yet', () => {
    const h = makeHarness({ hasEnded: false, runningCount: 0 });
    h.controller.onMasterEnded();
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('does nothing when the session is aborted or the bus already ended', () => {
    const aborted = makeHarness({ aborted: true });
    aborted.controller.onMasterEnded();
    expect(aborted.publish).not.toHaveBeenCalled();

    const busEnded = makeHarness({ busEnded: true });
    busEnded.controller.onMasterEnded();
    expect(busEnded.publish).not.toHaveBeenCalled();
  });

  it('auto-continues when the master pending flag is set', () => {
    const h = makeHarness();
    h.consumeMasterShouldContinue.mockReturnValueOnce(true);
    h.controller.onMasterEnded();
    expect(h.onAutoContinue).toHaveBeenCalledOnce();
    expect(h.publish).not.toHaveBeenCalled(); // didn't go idle — resumed instead
    expect(h.updateStatus).not.toHaveBeenCalled();
  });

  it('onSubordinatesChanged re-runs the idle check', () => {
    const h = makeHarness({ hasEnded: true, runningCount: 1 });
    h.controller.onSubordinatesChanged();
    expect(h.publish).not.toHaveBeenCalled();
    h.state.runningCount = 0;
    h.controller.onSubordinatesChanged();
    expect(h.publish).toHaveBeenCalledWith('session_idle', {
      reason: 'waiting_for_input',
    });
  });

  it('marks the bus done(idle_timeout) after the configured timeout elapses', () => {
    const h = makeHarness();
    h.controller.onMasterEnded();
    expect(h.publish).toHaveBeenCalled();
    expect(h.markEnded).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(h.markEnded).toHaveBeenCalledWith('done', { reason: 'idle_timeout' });
    expect(h.updateStatus).toHaveBeenLastCalledWith(42, 'completed');
  });

  it('cancels the timeout when a subordinate becomes running before it fires', () => {
    const h = makeHarness();
    h.controller.onMasterEnded();
    expect(h.publish).toHaveBeenCalled();
    h.state.runningCount = 1;
    vi.advanceTimersByTime(60_000);
    // The timer body re-checks conditions; with a running subordinate the
    // timeout body refuses to mark done.
    expect(h.markEnded).not.toHaveBeenCalled();
  });

  it('clear() cancels a pending timer', () => {
    const h = makeHarness();
    h.controller.onMasterEnded();
    h.controller.clear();
    vi.advanceTimersByTime(60_000);
    expect(h.markEnded).not.toHaveBeenCalled();
  });

  it('onMasterResurrected and onUserMessageReceived both clear the timer', () => {
    const harness1 = makeHarness();
    harness1.controller.onMasterEnded();
    harness1.controller.onMasterResurrected();
    vi.advanceTimersByTime(60_000);
    expect(harness1.markEnded).not.toHaveBeenCalled();

    const harness2 = makeHarness();
    harness2.controller.onMasterEnded();
    harness2.controller.onUserMessageReceived();
    vi.advanceTimersByTime(60_000);
    expect(harness2.markEnded).not.toHaveBeenCalled();
  });

  it('resetTimer replaces any previous pending timer', () => {
    const h = makeHarness();
    h.controller.onMasterEnded();
    // Second invocation re-enters checkIdle which resets the timer.
    vi.advanceTimersByTime(30_000);
    h.controller.onSubordinatesChanged();
    vi.advanceTimersByTime(30_000);
    expect(h.markEnded).not.toHaveBeenCalled(); // 60s NOT elapsed since last reset
    vi.advanceTimersByTime(30_000);
    expect(h.markEnded).toHaveBeenCalledOnce();
  });

  it('does not call updateStatus if it throws (best-effort persistence)', () => {
    const h = makeHarness();
    h.updateStatus.mockImplementationOnce(() => {
      throw new Error('db locked');
    });
    expect(() => h.controller.onMasterEnded()).not.toThrow();
    expect(h.publish).toHaveBeenCalled(); // publish still fires
  });
});
