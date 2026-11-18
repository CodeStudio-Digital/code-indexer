import { realpath } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { readWorktreeGit } from '@mcp/api-handlers/projectGit/index.js';
import { listProjectWorktrees } from '../../../worktree-reads.js';

vi.mock('@mcp/api-handlers/projectGit/index.js', () => ({ readWorktreeGit: vi.fn() }));

describe('desktop worktree inventory', () => {
  it('shares a live read, releases a cancelled subscriber and reads again after completion', async () => {
    const root = await realpath('.');
    const git = vi.mocked(readWorktreeGit);
    const success = { code: 0, stdout: `worktree ${root}\0HEAD abc\0branch refs/heads/main\0\0`, stderr: '' };
    let finish!: (value: typeof success) => void;
    git.mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(success);
    const controller = new AbortController();
    const a = listProjectWorktrees(root, { signal: controller.signal });
    const b = listProjectWorktrees(root);
    await vi.waitFor(() => expect(git).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(a).rejects.toMatchObject({ name: 'AbortError' });
    expect(git.mock.calls[0]![2].aborted).toBe(false);
    finish(success);
    expect((await b).worktrees[0]?.primary).toBe(true);
    await listProjectWorktrees(root);
    expect(git).toHaveBeenCalledTimes(2);
  });

  it('cancels abandoned work and allows a fresh caller to retry', async () => {
    const git = vi.mocked(readWorktreeGit).mockReset();
    git.mockImplementationOnce((_cwd, _args, signal) => new Promise(resolve => {
      signal.addEventListener('abort', () => resolve({ code: -1, stdout: '', stderr: 'cancelled' }));
    })).mockResolvedValueOnce({ code: 128, stdout: '', stderr: 'not a git repository' });
    const ctrl = new AbortController();
    const read = listProjectWorktrees('.', { signal: ctrl.signal });
    await vi.waitFor(() => expect(git).toHaveBeenCalledTimes(1));
    ctrl.abort();
    await expect(read).rejects.toMatchObject({ name: 'AbortError' });
    expect(git.mock.calls[0]![2].aborted).toBe(true);
    expect(await listProjectWorktrees('.')).toEqual({ isGit: false, worktrees: [] });
    expect(git).toHaveBeenCalledTimes(2);
  });
});
