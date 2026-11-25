import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCoder, type RunCoderHandle } from '@mcp/code-agent/index.js';
import { MasterLifecycle } from '../../MasterLifecycle.js';
import { handleSubordinateFailure } from '../../subordinate/completion-handler.js';

vi.mock('@mcp/code-agent/index.js', () => ({ runCoder: vi.fn() }));
vi.mock('@mcp/docs-agent/bridges/docs-bridge.js', () => ({ getReadyDocsResearchTools: () => [], installDocsDeepResearch: vi.fn() }));
vi.mock('../prompt-builder.js', () => ({ buildMasterPromptInputs: async () => ({ companyContext: {}, promptBlock: '', configuredStack: [] }) }));
vi.mock('../configure-skills.js', () => ({ configureMasterSkills: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const session = { master_session_id: 'master-chat', status: 'idle', config_json: null };
  const master = { id: 'master-run', coder_session_id: 'master-chat', role: 'master', status: 'completed', provider: 'fixture', model: 'master' };
  const files = {
    getSession: () => session,
    listBoardEntriesSync: () => [],
    listAgentRunsSync: () => [master],
    listAgentRuns: vi.fn(async () => [master]),
    updateSessionStatus: vi.fn(async () => {}),
    updateAgentRunStatus: vi.fn(async () => {}),
    clearRecoveryFlag: vi.fn(async () => {}),
  };
  const board = { post: vi.fn() };
  const lifecycle = new MasterLifecycle({
    ctx: { companySessionId: 'company', runtimeKind: 'company', companyFiles: files },
    board, status: { setStatus: vi.fn() }, eventBus: { emit: vi.fn() }, attention: { signal: vi.fn() },
    wirer: { wire: vi.fn() }, humanInLoop: { cancelPendingMasterPrompts: async () => [] },
  } as never);
  return { lifecycle, session, board, files };
}

function handle() {
  const done = deferred<{ reason: 'completed' }>();
  const runner = { isInputQueueClosed: false, pushUserMessage: vi.fn(), abort: vi.fn() };
  const value = { session: { id: 'master-chat' }, runner, done: done.promise } as unknown as RunCoderHandle;
  return { runner, done, value };
}

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('automatic Master wake', () => {
  it('resumes a cold chat once for concurrent results and delivers a permanent specialist failure to that same chat', async () => {
    const { lifecycle, files, board } = fixture();
    const listing = deferred<void>();
    files.listAgentRuns.mockImplementation(async () => { await listing.promise; return files.listAgentRunsSync(); });
    const current = handle();
    vi.mocked(runCoder).mockResolvedValue(current.value);
    lifecycle.notify('QA completed');
    lifecycle.notify('Review completed');
    await handleSubordinateFailure('builder-id', 'builder', 'invalid model', 'invalid model', {
      ctx: { companyFiles: files }, master: lifecycle, board, runningIds: new Set(['builder-id']),
      retryPolicy: { shouldRetry: () => false }, attention: { signal: vi.fn() }, kanban: { findCardForAgent: () => null },
    } as never);
    expect(files.listAgentRuns).toHaveBeenCalledTimes(1);
    listing.resolve();
    await vi.waitFor(() => expect(current.runner.pushUserMessage).toHaveBeenCalledTimes(2));
    expect(runCoder).toHaveBeenCalledTimes(1);
    expect(runCoder).toHaveBeenCalledWith(expect.objectContaining({ session: { id: 'master-chat' }, userMessage: 'QA completed' }));
    expect(current.runner.pushUserMessage.mock.calls[0]).toEqual(['Review completed']);
    expect(current.runner.pushUserMessage.mock.calls[1][0]).toContain('@builder (agent_run_id=builder-id) ended: invalid model');
    expect(lifecycle.agentRunId).toBe('master-run');
    expect(board.post.mock.calls.some(call => call[0] === 'human')).toBe(false);
  });

  it('holds a slow bootstrap and hands terminal-window events to a single successor after prompt cleanup', async () => {
    vi.useFakeTimers();
    const { lifecycle } = fixture();
    const old = handle();
    Object.assign(lifecycle, { _handle: old.value, _agentRunId: 'master-run', _companyContext: {}, _ended: true, _runnerExited: true });
    const boot = deferred<RunCoderHandle>();
    const first = handle();
    const second = handle();
    vi.mocked(runCoder).mockReturnValueOnce(boot.promise).mockResolvedValueOnce(second.value);
    lifecycle.notify('First specialist completed');
    await vi.advanceTimersByTimeAsync(95_000);
    lifecycle.notify('Second specialist completed');
    expect(runCoder).toHaveBeenCalledTimes(1);
    boot.resolve(first.value);
    await vi.advanceTimersByTimeAsync(0);
    expect(first.runner.pushUserMessage.mock.calls).toEqual([['Second specialist completed']]);
    first.runner.isInputQueueClosed = true;
    lifecycle.notify('Decision during shutdown');
    lifecycle.notify('Another completion');
    expect(runCoder).toHaveBeenCalledTimes(1);
    first.done.resolve({ reason: 'completed' });
    await vi.advanceTimersByTimeAsync(0);
    expect(runCoder).toHaveBeenCalledTimes(2);
    expect(runCoder).toHaveBeenLastCalledWith(expect.objectContaining({ session: { id: 'master-chat' }, userMessage: 'Decision during shutdown' }));
    expect(first.runner.pushUserMessage.mock.calls).toEqual([['Second specialist completed']]);
    expect(second.runner.pushUserMessage.mock.calls).toEqual([['Another completion']]);
    expect(old.runner.pushUserMessage).not.toHaveBeenCalled();
  });

  it.each(['paused', 'interrupted', 'error', 'completed'])('respects a persisted %s Company after worker restart', status => {
    const { lifecycle, session, files } = fixture();
    session.status = status;
    lifecycle.notify('Late completion');
    expect(files.listAgentRuns).not.toHaveBeenCalled();
    expect(runCoder).not.toHaveBeenCalled();
  });
});
