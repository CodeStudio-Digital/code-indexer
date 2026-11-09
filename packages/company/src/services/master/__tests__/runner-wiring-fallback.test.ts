import { describe, expect, it, vi } from 'vitest';
import { attachMasterCompletionHandler } from '../runner-wiring.js';

const COMPANY_SESSION_ID = '00000000-0000-4000-8000-000000000042';
const AGENT_RUN_ID = '00000000-0000-4000-8000-000000000007';

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
  const companyFiles = { updateAgentRunStatus: vi.fn(async () => undefined) };
  const board = { post: vi.fn() };
  const humanInLoop = {
    cancelPendingMasterPrompts: vi.fn(async () => []),
  };
  const handle = {
    done: result,
    session: { id: '00000000-0000-4000-8000-000000000099' },
  } as never;
  return {
    handle,
    state,
    companyFiles,
    board,
    humanInLoop,
    deps: {
      ctx: { companySessionId: COMPANY_SESSION_ID, companyFiles },
      board,
      humanInLoop,
      state,
    },
  };
}

describe('Master completion explicit fallback', () => {
  it('preserves an explicit pause when the aborted runner rejects during shutdown', async () => {
    const f = fixture(Promise.reject(new Error('transport closed during pause')));
    const tryExplicitFallback = vi.fn(async () => true);
    attachMasterCompletionHandler(f.handle, AGENT_RUN_ID, { ...f.deps, ctx: { ...f.deps.ctx, isAborted: true }, tryExplicitFallback } as never);
    await vi.waitFor(() => expect(f.state.setEnded).toHaveBeenCalledWith(true));
    expect(f.companyFiles.updateAgentRunStatus).not.toHaveBeenCalled();
    expect(tryExplicitFallback).not.toHaveBeenCalled();
  });
  it('keeps the agent_run alive when a transient failure starts the configured fallback', async () => {
    const f = fixture(Promise.resolve({ reason: 'error', error: 'HTTP 429 rate limit' }));
    const tryExplicitFallback = vi.fn(async () => true);
    attachMasterCompletionHandler(f.handle, AGENT_RUN_ID, { ...f.deps, tryExplicitFallback } as never);

    await vi.waitFor(() => expect(tryExplicitFallback).toHaveBeenCalledWith('HTTP 429 rate limit'));
    expect(f.companyFiles.updateAgentRunStatus).not.toHaveBeenCalled();
    expect(f.state.setEnded).not.toHaveBeenCalled();
    expect(f.state.notifyIdleEnded).not.toHaveBeenCalled();
  });

  it('terminalizes non-transient failures without consuming the fallback', async () => {
    const f = fixture(Promise.resolve({ reason: 'max_turns', error: null }));
    const tryExplicitFallback = vi.fn(async () => true);
    attachMasterCompletionHandler(f.handle, AGENT_RUN_ID, { ...f.deps, tryExplicitFallback } as never);

    await vi.waitFor(() => expect(f.state.setEnded).toHaveBeenCalledWith(true));
    expect(tryExplicitFallback).not.toHaveBeenCalled();
    expect(f.companyFiles.updateAgentRunStatus).toHaveBeenCalledWith(
      AGENT_RUN_ID,
      'error',
      'max_turns',
    );
    expect(f.state.notifyIdleEnded).toHaveBeenCalledTimes(1);
  });

  it('preserves the normal completed lifecycle', async () => {
    const f = fixture(Promise.resolve({ reason: 'completed', error: null }));
    const tryExplicitFallback = vi.fn(async () => true);
    attachMasterCompletionHandler(f.handle, AGENT_RUN_ID, { ...f.deps, tryExplicitFallback } as never);

    await vi.waitFor(() => expect(f.state.setEnded).toHaveBeenCalledWith(true));
    expect(tryExplicitFallback).not.toHaveBeenCalled();
    expect(f.companyFiles.updateAgentRunStatus).toHaveBeenCalledWith(
      AGENT_RUN_ID,
      'completed',
      undefined,
    );
  });
});
