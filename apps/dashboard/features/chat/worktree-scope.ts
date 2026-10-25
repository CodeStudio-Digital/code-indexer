import type { CoderSession } from './types.js';

export function worktreeKey(path: string | null | undefined): string {
  if (!path) return '';
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase() : normalized;
}

export function sessionsInWorktree(sessions: CoderSession[], path: string | null, primaryPath?: string): CoderSession[] {
  const primary = worktreeKey(primaryPath);
  const scope = worktreeKey(path);
  return sessions.filter((session) => {
    const key = worktreeKey(session.worktree_path);
    return (primary && key === primary ? '' : key) === scope;
  });
}
