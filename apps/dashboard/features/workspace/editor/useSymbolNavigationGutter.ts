import { useEffect } from 'react';
import type * as MonacoNs from 'monaco-editor';
import type { OpenFile } from '../../../state/workspace.js';
import { attachSymbolNavigationGutter } from './lsp/symbol-navigation-ui.js';

/** Attach the symbol gutter once per concrete editor model, not per keystroke. */
export function useSymbolNavigationGutter(
  file: OpenFile,
  editor: MonacoNs.editor.IStandaloneCodeEditor | null,
  monaco: typeof MonacoNs | null,
): void {
  const hasContent = file.content !== null;
  useEffect(() => {
    if (!editor || !monaco || !hasContent) return;
    if (file.kind && file.kind !== 'file') return;
    const handle = attachSymbolNavigationGutter(editor, monaco, file.projectId);
    return () => handle.dispose();
  }, [editor, monaco, hasContent, file.path, file.projectId, file.kind]);
}
