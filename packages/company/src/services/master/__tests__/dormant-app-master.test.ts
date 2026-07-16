import { describe, expect, it, vi } from 'vitest';

vi.mock('@mcp/docs-agent/bridges/docs-bridge.js', () => ({
  installDocsDeepResearch: vi.fn(),
}));

import { MasterLifecycle } from '../../MasterLifecycle.js';

describe('dormant App Master config refresh', () => {
  it('uses cold resume instead of cached resurrection on the next message', async () => {
    const board = { post: vi.fn() };
    const lifecycle = new MasterLifecycle({
      ctx: {
        runtimeKind: 'app_studio',
        companySessionId: 42,
        companyStore: {},
      },
      board,
      humanInLoop: { clearForAgent: vi.fn() },
      eventBus: { emit: vi.fn() },
      attention: { signal: vi.fn() },
    } as never);
    Object.assign(lifecycle as unknown as Record<string, unknown>, {
      _handle: { runner: {} },
      _agentRunId: 7,
      _ended: true,
      _runnerExited: true,
      _companyContext: { stale: true },
      _promptBlock: 'stale prompt',
    });
    const resume = vi.spyOn(lifecycle, 'resumeExisting').mockResolvedValue({
      masterSessionId: 99,
      indexStatus: null,
    });

    expect(lifecycle.sendUserMessage('Use the edited team config')).toEqual({ ok: true });
    await vi.waitFor(() => expect(resume).toHaveBeenCalledWith({
      userMessage: 'Use the edited team config',
      attachments: undefined,
      thinking: undefined,
    }));
    expect((lifecycle as unknown as { handle: unknown }).handle).toBeNull();
    expect(board.post).toHaveBeenCalledWith('human', null, 'message', 'Use the edited team config');
  });
});
