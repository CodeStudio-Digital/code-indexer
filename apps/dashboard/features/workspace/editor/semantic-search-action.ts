import type * as MonacoNs from 'monaco-editor';
import i18n from '../../../i18n/index.js';
import { useSeStore } from '../../search-everywhere/se-store.js';

export const SEMANTIC_SEARCH_ACTION_ID = 'mcp.semanticSearch';
const MAX_QUERY_CHARS = 1_000;

/** Selection first, then the word under the cursor, then the current line.
 * Kept pure so the contextual action can be validated without mounting Monaco. */
export function semanticQueryFromEditor(
  editor: Pick<MonacoNs.editor.IStandaloneCodeEditor, 'getModel' | 'getSelection' | 'getPosition'>,
): string {
  const model = editor.getModel();
  if (!model) return '';
  const selection = editor.getSelection();
  if (selection && !selection.isEmpty()) {
    return model.getValueInRange(selection).trim().slice(0, MAX_QUERY_CHARS);
  }
  const position = editor.getPosition();
  if (!position) return '';
  const word = model.getWordAtPosition(position)?.word.trim();
  if (word) return word.slice(0, MAX_QUERY_CHARS);
  return model.getLineContent(position.lineNumber).trim().slice(0, MAX_QUERY_CHARS);
}

/** Explicit, user-triggered semantic lookup. Registering the action performs
 * no request and never starts indexing; it only opens Search Everywhere when
 * invoked from the context menu or command palette. */
export function registerSemanticSearchAction(
  editor: MonacoNs.editor.IStandaloneCodeEditor,
): MonacoNs.IDisposable {
  return editor.addAction({
    id: SEMANTIC_SEARCH_ACTION_ID,
    label: i18n.t('search:everywhere.semanticAction'),
    contextMenuGroupId: 'navigation',
    contextMenuOrder: 1.6,
    run: () => {
      const query = semanticQueryFromEditor(editor);
      if (query) useSeStore.getState().openSemantic(query);
    },
  });
}
