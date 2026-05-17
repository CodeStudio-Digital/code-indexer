import { useEffect, useState } from 'react';

export interface ViewerPrefs {
  wrap: boolean;
  lineNumbers: boolean;
  renderMarkdown: boolean;
}

const KEY = 'mcp.builder.viewer.prefs';
const DEFAULT: ViewerPrefs = { wrap: false, lineNumbers: true, renderMarkdown: true };

function read(): ViewerPrefs {
  if (typeof window === 'undefined') return DEFAULT;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT;
    return { ...DEFAULT, ...(JSON.parse(raw) as Partial<ViewerPrefs>) };
  } catch {
    return DEFAULT;
  }
}

/**
 * Persisted viewer preferences (wrap, line numbers, markdown render).
 * Shared across file switches so the user's choice survives navigation.
 */
export function useViewerPrefs(): [ViewerPrefs, (patch: Partial<ViewerPrefs>) => void] {
  const [prefs, setPrefs] = useState<ViewerPrefs>(read);
  useEffect(() => {
    try { window.localStorage.setItem(KEY, JSON.stringify(prefs)); } catch {
      /* quota / privacy mode — ignore */
    }
  }, [prefs]);
  return [prefs, (patch) => setPrefs((p) => ({ ...p, ...patch }))];
}
