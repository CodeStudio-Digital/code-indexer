import {
  editorChatContextActions,
  formatSelections,
  MAX_SELECTION_CHARS,
  selectionId,
  type CodeSelection,
} from '../../../state/editor-chat-context.js';
import { readActiveSelection } from '../../workspace/editor/chat-actions.js';

/** Capture the current selection alongside pinned snippets, then clear staging. */
export function consumeEditorContext(projectId: number, selections: CodeSelection[]): string {
  const raw = readActiveSelection();
  const live = raw && raw.projectId === projectId
    ? {
        id: selectionId(raw.path, raw.startLine, raw.endLine),
        path: raw.path,
        startLine: raw.startLine,
        endLine: raw.endLine,
        text: raw.text.slice(0, MAX_SELECTION_CHARS),
      }
    : null;
  const allSelections = live && !selections.some((selection) => selection.id === live.id)
    ? [...selections, live]
    : selections;
  const prefix = formatSelections(allSelections);
  editorChatContextActions().clear(projectId);
  return prefix;
}
