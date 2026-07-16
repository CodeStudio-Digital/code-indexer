import { describe, expect, it, vi } from 'vitest';
import { attachMasterCompletionHandler } from '../runner-wiring.js';

function fixture(result: Promise<unknown>) {
  const state = {
    attentionOff: null,
    setAttentionOff: vi.fn(),
    setRunnerExited: vi.fn(),
    setEnded: vi.fn(),
    setEndedAt: vi.fn(),
    setEndedWithError: vi.fn(),
    isEnded: false,
    isRunnerExited: false,
    notifyIdleEnded: vi.fn(),
  };
  const companyStore = { updateAgentRunStatus: vi.fn() };
  const board = { post: vi.fn() };
  const humanInLoop = { cancelPendingMasterPrompts: vi.fn() };
  const handle = { done: result, session: { id: 1 } } as never;
  return {
    handle,
    state,
    companyStore,
    board,
    humanInLoop,
    deps: {
      ctx: { companySessionId: 42, companyStore },
      board,
      humanInLoop,
      state,
    },
  };
}

describe('Master completion explicit fallback', () => {
  it('keeps the agent_run alive when a transient failure starts the configured fallback', async () => {
    const f = fixture(Promise.resolve({ reason: 'error', error: 'HTTP 429 rate limit' }));
    const tryExplicitFallback = vi.fn(async () => true);
    attachMasterCompletionHandler(f.handle, 7, { ...f.deps, tryExplicitFallback } as never);

    await vi.waitFor(() => expect(tryExplicitFallback).toHaveBeenCalledWith('HTTP 429 rate limit'));
    expect(f.companyStore.updateAgentRunStatus).not.toHaveBeenCalled();
    expect(f.state.setEnded).not.toHaveBeenCalled();
    expect(f.state.notifyIdleEnded).not.toHaveBeenCalled();
  });

  it('terminalizes non-transient failures without consuming the fallback', async () => {
    const f = fixture(Promise.resolve({ reason: 'max_turns', error: null }));
    const tryExplicitFallback = vi.fn(async () => true);
    attachMasterCompletionHandler(f.handle, 7, { ...f.deps, tryExplicitFallback } as never);

    await vi.waitFor(() => expect(f.state.setEnded).toHaveBeenCalledWith(true));
    expect(tryExplicitFallback).not.toHaveBeenCalled();
    expect(f.companyStore.updateAgentRunStatus).toHaveBeenCalledWith(
      7,
      'error',
      'max_turns',
    );
    expect(f.state.notifyIdleEnded).toHaveBeenCalledTimes(1);
  });

  it('preserves the normal completed lifecycle', async () => {
    const f = fixture(Promise.resolve({ reason: 'completed', error: null }));
    const tryExplicitFallback = vi.fn(async () => true);
    attachMasterCompletionHandler(f.handle, 7, { ...f.deps, tryExplicitFallback } as never);

    await vi.waitFor(() => expect(f.state.setEnded).toHaveBeenCalledWith(true));
    expect(tryExplicitFallback).not.toHaveBeenCalled();
    expect(f.companyStore.updateAgentRunStatus).toHaveBeenCalledWith(
      7,
      'completed',
      undefined,
    );
  });
});
