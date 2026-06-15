import React from 'react';
import { FileCode2, MousePointerClick, X } from 'lucide-react';
import {
  getSelections,
  removeSelected,
  selectionKey,
  setSelected,
  subscribeSelected,
  type SelectedElement,
} from '../studio-context-store.js';
import { setPendingReveal } from '../../../workspace/editor/pending-reveal.js';
import { useWorkspaceStore } from '../../../../state/workspace.js';

/**
 * Shows the preview element(s) the user picked while select mode is armed.
 * A plain click sets one; Ctrl/Cmd-click ADDS more, so several elements can
 * be cited in a single message. Each chip's source location is prefixed onto
 * the next chat message (see `consumeSelectionPrefix`) so the builder agent
 * edits exactly what was pointed at. Every chip is dismissible; a "clear all"
 * appears once more than one is selected.
 */
export function SelectionChip({ sessionId, projectId }: { sessionId: number; projectId?: number }) {
  const selections = useSelections(sessionId);
  if (!selections.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {selections.map((sel) => (
        <SelectionChipItem
          key={selectionKey(sel)}
          selected={sel}
          projectId={projectId}
          onRemove={() => removeSelected(sessionId, selectionKey(sel))}
        />
      ))}
      {selections.length > 1 && (
        <button
          type="button"
          onClick={() => setSelected(sessionId, null)}
          className="ml-0.5 px-1 text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
        >
          Limpar tudo
        </button>
      )}
    </div>
  );
}

/** A single selected-element chip: name + source loc, open-in-editor, dismiss. */
function SelectionChipItem({
  selected,
  projectId,
  onRemove,
}: {
  selected: SelectedElement;
  projectId?: number;
  onRemove: () => void;
}) {
  const name = selected.componentName || selected.tag;
  const target = projectId != null ? parseLoc(selected.loc) : null;

  function openInEditor() {
    if (projectId == null || !target) return;
    const store = useWorkspaceStore.getState();
    const existing = store.openFiles.find((f) => f.path === target.path && f.projectId === projectId);
    if (!existing) {
      store.openFile({
        kind: 'file',
        projectId,
        path: target.path,
        content: null,
        dirty: false,
        lastModified: null,
      });
    } else {
      store.setActive(target.path);
    }
    setPendingReveal(target.path, { line: target.line, column: target.column });
    // The files tab hosts the editor — ProjectView listens and switches.
    window.dispatchEvent(new CustomEvent('mcp:open-files-tab', { detail: { projectId } }));
  }

  return (
    <div className="flex items-center gap-1.5 rounded-md border border-indigo-300 bg-indigo-50 dark:border-indigo-800 dark:bg-indigo-950/40 px-2 py-1 text-xs">
      <MousePointerClick className="h-3.5 w-3.5 text-indigo-500 shrink-0" />
      <span className="font-medium text-indigo-700 dark:text-indigo-300">&lt;{name}&gt;</span>
      {selected.loc && (
        <span className="text-muted-foreground truncate max-w-[180px]" title={selected.loc}>
          {selected.loc}
        </span>
      )}
      {target && (
        <button
          type="button"
          onClick={openInEditor}
          className="text-indigo-500 hover:text-indigo-700 dark:hover:text-indigo-300"
          title={`Open ${target.path}:${target.line} in the editor`}
          aria-label="Open in editor"
        >
          <FileCode2 className="h-3.5 w-3.5" />
        </button>
      )}
      <button
        type="button"
        onClick={onRemove}
        className="ml-0.5 text-muted-foreground hover:text-foreground"
        aria-label="Clear selection"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

/**
 * Parse the stamp loc `src/App.tsx:42:8` from the RIGHT — the path may
 * contain drive-less folders but never trailing `:n:n` segments of its own.
 * Returns null for selections without a source loc (universal-inspector
 * fallbacks emit selector-only payloads).
 */
function parseLoc(loc: string | undefined): { path: string; line: number; column: number } | null {
  if (!loc) return null;
  const m = /^(.*):(\d+):(\d+)$/.exec(loc);
  if (!m) return null;
  const line = Number(m[2]);
  const column = Number(m[3]);
  if (!Number.isFinite(line) || line < 1) return null;
  return { path: m[1].replace(/\\/g, '/'), line, column: Math.max(1, column) };
}

/** Subscribe to the module store for this session's current selection list. */
function useSelections(sessionId: number): SelectedElement[] {
  const [sels, setSels] = React.useState<SelectedElement[]>(() => getSelections(sessionId));
  React.useEffect(() => {
    setSels(getSelections(sessionId));
    return subscribeSelected(sessionId, () => setSels(getSelections(sessionId)));
  }, [sessionId]);
  return sels;
}
