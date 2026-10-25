import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CoderWorktrees } from '@mcp/api-bus';
import { useApi } from '../../hooks/useApi.js';
import { sessionsInWorktree, worktreeKey } from './worktree-scope.js';
import type { CoderSession } from './types.js';

export function useSessionWorktrees({ projectId, isGlobal, sessions, selectedId, selectedSession, onSelect }: {
  projectId?: number;
  isGlobal: boolean;
  sessions: CoderSession[] | null;
  selectedId: string | null;
  selectedSession: CoderSession | null;
  onSelect: (id: string | null) => void;
}) {
  const storageKey = `chat-worktree:${projectId}`;
  const readPath = useCallback(() => {
    try { return localStorage.getItem(storageKey) || null; } catch { return null; }
  }, [storageKey]);
  const [scope, setScope] = useState(() => ({ projectId, path: readPath() }));
  const path = isGlobal ? null : scope.projectId === projectId ? scope.path : readPath();
  const { data: inventory, loading, error, refetch } = useApi<CoderWorktrees & { projectId: number }>(
    !isGlobal && projectId != null ? `/coder/worktrees?project_id=${projectId}` : '',
  );
  const data = useMemo(() => {
    if (!inventory || inventory.projectId !== projectId) return null;
    const worktrees = [...inventory.worktrees];
    for (const session of sessions ?? []) {
      const path = session.worktree_path;
      if (session.project_id !== projectId || !path || worktrees.some(item => worktreeKey(item.path) === worktreeKey(path))) continue;
      // Keep the history reachable even when its checkout was removed outside Git.
      worktrees.push({ path, branch: path.split(/[\\/]/).pop() ?? path, head: '', primary: false, locked: false, prunable: true });
    }
    return { ...inventory, worktrees };
  }, [inventory, projectId, sessions]);
  const remembered = useRef(new Map<string, string>());
  const primaryPath = data?.worktrees.find((item) => item.primary)?.path;
  const visible = useMemo(() => isGlobal ? sessions : sessionsInWorktree((sessions ?? []).filter(item => item.project_id === projectId), path, primaryPath),
    [isGlobal, sessions, path, primaryPath, projectId]);
  const selectPath = useCallback((next: string | null) => {
    setScope({ projectId, path: next });
    try {
      if (next) localStorage.setItem(storageKey, next);
      else localStorage.removeItem(storageKey);
    } catch { /* Storage can be unavailable in a restricted webview. */ }
  }, [projectId, storageKey]);

  // Deep links, imports, duplicates and agent-driven enter/exit follow their
  // persisted checkout. Never infer scope from a stale detail response.
  useEffect(() => {
    if (isGlobal || !selectedId) return;
    const session = selectedSession?.id === selectedId && selectedSession.project_id === projectId
      ? selectedSession : sessions?.find((item) => item.id === selectedId && item.project_id === projectId);
    if (!session) return;
    const next = worktreeKey(session.worktree_path) === worktreeKey(primaryPath) ? null : session.worktree_path ?? null;
    if (worktreeKey(next) !== worktreeKey(path)) selectPath(next);
    remembered.current.set(`${projectId}:${worktreeKey(next)}`, selectedId);
  }, [isGlobal, selectedId, selectedSession, sessions, primaryPath, path, projectId, selectPath]);

  useEffect(() => {
    const refresh = () => refetch();
    window.addEventListener('focus', refresh);
    window.addEventListener('coder:sessions-changed', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('coder:sessions-changed', refresh);
    };
  }, [refetch]);

  const switchTo = useCallback((next: string | null) => {
    if (selectedId) remembered.current.set(`${projectId}:${worktreeKey(path)}`, selectedId);
    const candidates = sessionsInWorktree((sessions ?? []).filter(item => item.project_id === projectId), next, primaryPath);
    const previous = remembered.current.get(`${projectId}:${worktreeKey(next)}`);
    selectPath(next);
    onSelect(candidates.find((item) => item.id === previous)?.id ?? candidates[0]?.id ?? null);
  }, [path, selectedId, projectId, sessions, primaryPath, selectPath, onSelect]);
  const unavailable = !!path && !loading && !data?.worktrees.some((item) => !item.prunable && worktreeKey(item.path) === worktreeKey(path));
  return { path, visible, data, loading, error, refetch, switchTo, unavailable };
}
