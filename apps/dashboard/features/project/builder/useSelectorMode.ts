/**
 * Per-project preview element-selector mode, persisted in localStorage
 * (mirrors `useProjectDevServer`'s manual-URL pattern). The universal CDP
 * picker can run React-native detection or the generic CSS "universal" one;
 * 'auto' resolves to 'react' for React/Next projects and 'universal' otherwise.
 * The user can pin a mode explicitly. Re-reads on projectId change because
 * React reuses the hook instance across project navigation.
 */
import { useCallback, useEffect, useState } from 'react';

/** Inferred framework from the project DTO (`Project.framework`). */
export type PreviewFramework = 'next' | 'react' | 'vue' | 'angular' | null | undefined;
/** User-facing preference. */
export type SelectorMode = 'auto' | 'react' | 'universal';
/** What the inspector actually runs as (no 'auto'). */
export type EffectiveSelectorMode = 'react' | 'universal';

function storageKey(projectId: number): string {
  return `mcp.preview.selectorMode.${projectId}`;
}

function read(projectId: number): SelectorMode {
  try {
    const v = localStorage.getItem(storageKey(projectId));
    return v === 'react' || v === 'universal' || v === 'auto' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

/** Resolve 'auto' against the detected framework. */
function effectiveSelectorMode(mode: SelectorMode, framework: PreviewFramework): EffectiveSelectorMode {
  if (mode === 'react' || mode === 'universal') return mode;
  return framework === 'react' || framework === 'next' ? 'react' : 'universal';
}

export function useSelectorMode(projectId: number, framework: PreviewFramework) {
  const [mode, setMode] = useState<SelectorMode>(() => read(projectId));
  useEffect(() => {
    setMode(read(projectId));
  }, [projectId]);

  const update = useCallback(
    (next: SelectorMode) => {
      setMode(next);
      try {
        if (next === 'auto') localStorage.removeItem(storageKey(projectId));
        else localStorage.setItem(storageKey(projectId), next);
      } catch {
        /* ignore */
      }
    },
    [projectId],
  );

  return { mode, setMode: update, effective: effectiveSelectorMode(mode, framework) };
}
