import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { CoderWorktrees } from '@mcp/api-bus';
import { useApi } from '../../hooks/useApi.js';
import { useWorktreeSelection, worktreeKey, type WorktreeSelection } from '../../state/worktree-selection.js';
import { sessionsInWorktree } from './worktree-scope.js';
import type { CoderSession } from './types.js';

export function useWorktreeInventory(projectId?: number) {
  const inventory = useApi<CoderWorktrees & { projectId: number }>(
    projectId != null ? `/coder/worktrees?project_id=${projectId}` : '',
  );
  const reload = inventory.refetch;
  const refetch = useCallback(() => {
    window.dispatchEvent(new CustomEvent('coder:worktrees-changed', { detail: { projectId } }));
  }, [projectId]);
  useEffect(() => {
    if (projectId == null) return;
    const changed = (event: Event) => {
      const source = (event as CustomEvent<{ projectId?: number }>).detail?.projectId;
      if (source == null || source === projectId) reload();
    };
    window.addEventListener('focus', reload);
    window.addEventListener('coder:worktrees-changed', changed);
    return () => {
      window.removeEventListener('focus', reload);
      window.removeEventListener('coder:worktrees-changed', changed);
    };
  }, [projectId, reload]);
  return { ...inventory, refetch, data: inventory.data?.projectId === projectId ? inventory.data : null };
}

export function useSessionWorktrees({ projectId, isGlobal, sessions, selectedId, selectedSession, onSelect, selection }: {
  projectId?: number;
  isGlobal: boolean;
  sessions: CoderSession[] | null;
  selectedId: string | null;
  selectedSession: CoderSession | null;
  onSelect: (id: string | null) => void;
  selection?: WorktreeSelection;
}) {
  const local = useWorktreeSelection(selection ? undefined : projectId);
  const { path: storedPath, setPath: selectPath } = selection ?? local;
  const path = isGlobal ? null : storedPath;
  const { data: inventory, loading, error, refetch } = useWorktreeInventory(isGlobal ? undefined : projectId);
  // Session names, messages and activity change frequently. Only a change in
  // checkout bindings can mean an agent created or removed a worktree.
  const activeId = selectedSession?.project_id === projectId ? selectedSession?.id : undefined;
  const activeCheckout = worktreeKey(selectedSession?.worktree_path);
  const bindings = useMemo(() => {
    if (!sessions || isGlobal) return null;
    const paths = new Map(sessions.filter(s => s.project_id === projectId).map(s => [s.id, worktreeKey(s.worktree_path)]));
    if (activeId) paths.set(activeId, activeCheckout);
    return JSON.stringify([...new Set(paths.values())].filter(Boolean).sort());
  }, [sessions, activeId, activeCheckout, projectId, isGlobal]);
  const previousBindings = useRef<{ projectId?: number; bindings: string } | null>(null);
  useEffect(() => {
    if (bindings == null) return;
    const previous = previousBindings.current;
    previousBindings.current = { projectId, bindings };
    if (previous && previous.projectId === projectId && previous.bindings !== bindings) refetch();
  }, [bindings, projectId, refetch]);
  const data = useMemo(() => {
    if (!inventory || inventory.projectId !== projectId) return null;
    const worktrees = [...inventory.worktrees];
    const known = new Set(worktrees.map(item => worktreeKey(item.path)));
    for (const session of sessions ?? []) {
      const path = session.worktree_path;
      const key = worktreeKey(path);
      if (session.project_id !== projectId || !path || known.has(key)) continue;
      known.add(key);
      // Keep the history reachable even when its checkout was removed outside Git.
      worktrees.push({ path, branch: path.split(/[\\/]/).pop() ?? path, head: '', primary: false, locked: false, prunable: true, historyOnly: true });
    }
    return { ...inventory, worktrees };
  }, [inventory, projectId, sessions]);
  const remembered = useRef(new Map<string, string>());
  const primaryPath = data?.worktrees.find((item) => item.primary)?.path;
  const visible = useMemo(() => isGlobal ? sessions : sessionsInWorktree((sessions ?? []).filter(item => item.project_id === projectId), path, primaryPath),
    [isGlobal, sessions, path, primaryPath, projectId]);
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

  const switchTo = useCallback((next: string | null) => {
    if (selectedId) remembered.current.set(`${projectId}:${worktreeKey(path)}`, selectedId);
    const candidates = sessionsInWorktree((sessions ?? []).filter(item => item.project_id === projectId), next, primaryPath);
    const previous = remembered.current.get(`${projectId}:${worktreeKey(next)}`);
    selectPath(next);
    onSelect(candidates.find((item) => item.id === previous)?.id ?? candidates[0]?.id ?? null);
  }, [path, selectedId, projectId, sessions, primaryPath, selectPath, onSelect]);
  const registerSessionSwitch = selection?.registerSessionSwitch;
  useLayoutEffect(() => registerSessionSwitch?.(switchTo), [registerSessionSwitch, switchTo]);
  const unavailable = !!path && !loading && !data?.worktrees.some((item) => !item.prunable && worktreeKey(item.path) === worktreeKey(path));
  return { path, visible, data, loading, error, refetch, switchTo, unavailable };
}
