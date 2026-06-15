import React, { useState } from 'react';
import { ChevronDown, ChevronUp, Paintbrush, TextCursorInput, Undo2 } from 'lucide-react';
import type { ParentToPreviewMessage } from '@mcp/services/sandbox/builder/protocol.js';
import { LAYOUT_GROUPS, STYLE_GROUPS } from './tailwind-class-model.js';
import { ClassGroupControls } from './ClassGroupControls.js';
import { useVisualEdit } from './useVisualEdit.js';

interface VisualEditPanelProps {
  projectId: number;
  postToPreview: (msg: ParentToPreviewMessage) => void;
  origin: string;
  /** Stamped iframe live on screen (not popped out / agent preview). */
  enabled: boolean;
}

/**
 * Two-way visual editing for the selected preview element: inline text +
 * Tailwind class controls written straight to the source (no AI round
 * trip). Renders under the preview whenever an element is selected;
 * everything beyond the supported groups stays agent territory.
 */
export function VisualEditPanel({ projectId, postToPreview, origin, enabled }: VisualEditPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const {
    selected,
    classes,
    locCount,
    refusal,
    canEdit,
    agentBusy,
    dirtyInEditor,
    runtimeReady,
    canUndo,
    applyClasses,
    undo,
    beginTextEdit,
  } = useVisualEdit(projectId, { postToPreview, origin, enabled });

  if (!enabled || !selected?.loc) return null;

  const blockNote = agentBusy
    ? 'Agent is working — visual edits resume when it finishes.'
    : dirtyInEditor
      ? 'File has unsaved editor changes — save the tab first.'
      : null;

  return (
    <div className="border-t bg-card/60 text-xs">
      <div className="flex items-center gap-2 px-2 py-1">
        <Paintbrush className="h-3.5 w-3.5 text-indigo-500 shrink-0" />
        <span className="font-medium">Visual edit</span>
        {locCount > 1 && (
          <span
            className="rounded bg-amber-500/15 px-1 text-[10px] text-amber-700 dark:text-amber-300"
            title="This element is rendered from a list — the source edit changes all instances."
          >
            edits all {locCount} instances
          </span>
        )}
        {blockNote && <span className="text-[10px] text-muted-foreground truncate">{blockNote}</span>}
        <span className="flex-1" />
        <button
          type="button"
          onClick={beginTextEdit}
          disabled={!canEdit}
          className="flex items-center gap-1 rounded border px-1.5 py-0.5 hover:bg-muted disabled:opacity-40"
          title="Edit the element's text directly in the preview (Enter commits, Esc cancels)"
        >
          <TextCursorInput className="h-3 w-3" /> Edit text
        </button>
        <button
          type="button"
          onClick={undo}
          disabled={!canUndo || !canEdit}
          className="flex items-center gap-1 rounded border px-1.5 py-0.5 hover:bg-muted disabled:opacity-40"
          title="Undo the last class change"
        >
          <Undo2 className="h-3 w-3" /> Undo
        </button>
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="rounded p-0.5 hover:bg-muted"
          aria-label={collapsed ? 'Expand visual edit' : 'Collapse visual edit'}
        >
          {collapsed ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>
      </div>
      {refusal && (
        <div className="px-2 pb-1 text-[11px] text-destructive break-words" role="alert">
          {refusal}
        </div>
      )}
      {runtimeReady === false && !refusal && (
        <div className="px-2 pb-1 text-[11px] text-amber-700 dark:text-amber-300 break-words">
          Preview tooling is outdated (no live edit runtime) — click the Wrench button to update
          it, then restart the dev server. Edits still write to source; only the instant feedback
          and inline text editing are missing.
        </div>
      )}
      {!collapsed && (
        <div className="space-y-1.5 px-2 pb-2">
          <ClassGroupControls
            groups={LAYOUT_GROUPS}
            classes={classes}
            disabled={!canEdit}
            onChange={applyClasses}
          />
          <ClassGroupControls
            groups={STYLE_GROUPS}
            classes={classes}
            disabled={!canEdit}
            onChange={applyClasses}
          />
        </div>
      )}
    </div>
  );
}
