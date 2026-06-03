import React from 'react';
import { MousePointerClick, X } from 'lucide-react';
import {
  getSelected,
  setSelected,
  subscribeSelected,
  type SelectedElement,
} from '../studio-context-store.js';

/**
 * Shows the currently-selected preview element (set by clicking in the
 * preview while select mode is armed). The next chat message is prefixed
 * with this element's source location so the builder agent edits exactly
 * what the user pointed at. Dismissible.
 */
export function SelectionChip({ sessionId }: { sessionId: number }) {
  const selected = useSelectedElement(sessionId);
  if (!selected) return null;
  const name = selected.componentName || selected.tag;
  return (
    <div className="flex items-center gap-1.5 rounded-md border border-indigo-300 bg-indigo-50 dark:border-indigo-800 dark:bg-indigo-950/40 px-2 py-1 text-xs">
      <MousePointerClick className="h-3.5 w-3.5 text-indigo-500 shrink-0" />
      <span className="font-medium text-indigo-700 dark:text-indigo-300">&lt;{name}&gt;</span>
      <span className="text-muted-foreground truncate max-w-[180px]" title={selected.loc}>
        {selected.loc}
      </span>
      <button
        type="button"
        onClick={() => setSelected(sessionId, null)}
        className="ml-0.5 text-muted-foreground hover:text-foreground"
        aria-label="Clear selection"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

/** Subscribe to the module store for this session's current selection. */
function useSelectedElement(sessionId: number): SelectedElement | null {
  const [sel, setSel] = React.useState<SelectedElement | null>(() => getSelected(sessionId));
  React.useEffect(() => {
    setSel(getSelected(sessionId));
    return subscribeSelected(sessionId, () => setSel(getSelected(sessionId)));
  }, [sessionId]);
  return sel;
}
