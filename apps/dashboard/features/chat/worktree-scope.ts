import type { CoderSession } from './types.js';
import { worktreeKey } from '../../state/worktree-selection.js';

export function sessionsInWorktree(sessions: CoderSession[], path: string | null, primaryPath?: string): CoderSession[] {
  const primary = worktreeKey(primaryPath);
  const scope = worktreeKey(path);
  return sessions.filter((session) => {
    const key = worktreeKey(session.worktree_path);
    return (primary && key === primary ? '' : key) === scope;
  });
}
