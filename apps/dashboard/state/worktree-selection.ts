import { useCallback, useMemo, useRef, useState } from 'react';

export interface WorktreeSelection {
  path: string | null;
  setPath: (path: string | null) => void;
  select: (path: string | null) => void;
  registerSessionSwitch: (switchTo: (path: string | null) => void) => (() => void);
}

export function worktreeKey(path: string | null | undefined): string {
  if (!path) return '';
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase() : normalized;
}

export function useWorktreeSelection(projectId?: number, onManualSelection?: () => void): WorktreeSelection {
  const storageKey = projectId == null ? null : `chat-worktree:${projectId}`;
  const readPath = () => {
    try { return storageKey ? localStorage.getItem(storageKey) || null : null; } catch { return null; }
  };
  const [scope, setScope] = useState(() => ({ projectId, path: readPath() }));
  const sessionSwitch = useRef<{ projectId?: number; switchTo: (path: string | null) => void } | null>(null);
  const path = scope.projectId === projectId ? scope.path : readPath();
  const setPath = useCallback((next: string | null) => {
    setScope({ projectId, path: next });
    if (!storageKey) return;
    try {
      if (next) localStorage.setItem(storageKey, next);
      else localStorage.removeItem(storageKey);
    } catch { /* Storage can be unavailable in a restricted webview. */ }
  }, [projectId, storageKey]);
  const select = useCallback((next: string | null) => {
    onManualSelection?.();
    const current = sessionSwitch.current;
    if (current && current.projectId === projectId) current.switchTo(next);
    else setPath(next);
  }, [projectId, setPath, onManualSelection]);
  const registerSessionSwitch = useCallback((switchTo: (path: string | null) => void) => {
    const entry = { projectId, switchTo };
    sessionSwitch.current = entry;
    return () => { if (sessionSwitch.current === entry) sessionSwitch.current = null; };
  }, [projectId]);
  return useMemo(() => ({ path, setPath, select, registerSessionSwitch }), [path, setPath, select, registerSessionSwitch]);
}
