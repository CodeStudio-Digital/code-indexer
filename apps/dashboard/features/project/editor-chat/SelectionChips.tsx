/**
 * Context chips above the rail composer:
 *   - the LIVE editor selection (Copilot-style, auto-tracked, dashed) — sent
 *     with the next message; dismiss with ✕ or pin it with the pin button;
 *   - PINNED selections (Ctrl/Cmd+I) that accumulate until sent.
 *
 * File references ride as `filePicks` pills inside the Composer itself.
 */
import { useTranslation } from 'react-i18next';
import { Code2, Pin, X } from 'lucide-react';
import {
  editorChatContextActions,
  useEditorChatContext,
  useEditorChatContextStore,
  useLiveSelection,
  type CodeSelection,
} from '../../../state/editor-chat-context.js';

export function SelectionChips({ projectId }: { projectId: number }) {
  const { t } = useTranslation('workspace');
  const { selections } = useEditorChatContext(projectId);
  const live = useLiveSelection(projectId);
  const removeSelection = useEditorChatContextStore((s) => s.removeSelection);

  // Hide the live chip when its range is already pinned (avoids a duplicate).
  const showLive = live != null && !selections.some((s) => s.id === live.id);
  if (!showLive && selections.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1 px-3 pt-2">
      {showLive && live && (
        <div
          className="group inline-flex items-center gap-1 h-6 pl-1.5 pr-1 rounded-md border border-dashed border-violet-500/40 bg-violet-500/5 text-violet-600 dark:text-violet-300 text-[11px] max-w-[240px]"
          title={t('editorChat.currentSelection')}
        >
          <Code2 className="h-3 w-3 shrink-0" />
          <span className="truncate">{live.path.split('/').pop() ?? live.path}</span>
          <span className="shrink-0 opacity-60 font-mono">
            {t('editorChat.lineRange', { start: live.startLine, end: live.endLine })}
          </span>
          <button
            type="button"
            onClick={() => {
              const { id: _id, ...rest } = live;
              editorChatContextActions().addSelection(projectId, rest);
              editorChatContextActions().setLiveSelection(projectId, null);
            }}
            className="shrink-0 p-0.5 rounded hover:bg-violet-500/20 text-violet-500/60 hover:text-violet-600 dark:hover:text-violet-300"
            aria-label={t('editorChat.pinSelection')}
          >
            <Pin className="h-2.5 w-2.5" />
          </button>
          <button
            type="button"
            onClick={() => editorChatContextActions().setLiveSelection(projectId, null)}
            className="shrink-0 p-0.5 rounded hover:bg-violet-500/20 text-violet-500/60 hover:text-violet-600 dark:hover:text-violet-300"
            aria-label={t('editorChat.removeSelection')}
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </div>
      )}

      {selections.map((sel: CodeSelection) => (
        <div
          key={sel.id}
          className="group inline-flex items-center gap-1 h-6 pl-1.5 pr-1 rounded-md border border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400 text-[11px] max-w-[240px]"
          title={sel.path}
        >
          <Code2 className="h-3 w-3 shrink-0" />
          <span className="truncate">{sel.path.split('/').pop() ?? sel.path}</span>
          <span className="shrink-0 opacity-60 font-mono">
            {t('editorChat.lineRange', { start: sel.startLine, end: sel.endLine })}
          </span>
          <button
            type="button"
            onClick={() => removeSelection(projectId, sel.id)}
            className="shrink-0 p-0.5 rounded hover:bg-violet-500/20 text-violet-500/70 hover:text-violet-600 dark:hover:text-violet-300"
            aria-label={t('editorChat.removeSelection')}
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
