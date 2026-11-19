import { describe, expect, it } from 'vitest';
import { worktreeKey } from '../../../state/worktree-selection.js';
import { sessionsInWorktree } from '../worktree-scope.js';
import type { CoderSession } from '../types.js';

describe('session checkout filtering', () => {
  const sessions = [
    { id: 'main', worktree_path: null },
    { id: 'legacy' },
    { id: 'explicit-main', worktree_path: 'D:\\project' },
    { id: 'feature', worktree_path: 'D:\\project\\.mcp-indexer\\worktrees\\feature' },
    { id: 'other', worktree_path: 'D:/external/other' },
  ] as CoderSession[];
  it('keeps normal sessions in main and isolates actions to the selected checkout', () => {
    expect(sessionsInWorktree(sessions, null, 'D:/project').map(item => item.id)).toEqual(['main', 'legacy', 'explicit-main']);
    expect(sessionsInWorktree(sessions, 'd:/PROJECT/.mcp-indexer/worktrees/feature/', 'D:/project').map(item => item.id)).toEqual(['feature']);
    expect(sessionsInWorktree(sessions, 'D:/external/other').map(item => item.id)).toEqual(['other']);
  });
  it('normalizes Windows paths while keeping POSIX paths case sensitive', () => {
    expect(worktreeKey('D:\\REPO\\')).toBe('d:/repo');
    expect(worktreeKey('/Repo')).not.toBe(worktreeKey('/repo'));
  });
});
