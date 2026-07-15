/**
 * Imperative Monaco lifecycle for the 3-pane merge editor (Local | Result |
 * Incoming). Kept OUT of editor-models.ts on purpose: those are real-file
 * models under a 20-model LRU; these are short-lived, tab-scoped, and disposed
 * deterministically on tab close. Synthetic URIs are prefixed (`/merge-<role>/…`)
 * so they never alias a real file path. Glyph margin is enabled for the gutter
 * accept-arrows; the Result is seeded by the caller (the marker-free merge).
 */

import * as monaco from 'monaco-editor';
import { languageIdForPath } from '@mcp/shared/utils/language-id.js';

export interface Pane {
  editor: monaco.editor.IStandaloneCodeEditor;
  model: monaco.editor.ITextModel;
}

export interface ThreePaneInit {
  file: string;
  ours: string;
  theirs: string;
  /** Marker-free seed for the editable Result pane (from buildInitialResult). */
  result: string;
  /** Process-wide theme snapshot; all Monaco surfaces must use the same id. */
  theme: string;
}

export interface ThreePaneHandles {
  ours: Pane;
  result: Pane;
  theirs: Pane;
  getResult(): string;
  dispose(): void;
}

const BASE_OPTS: monaco.editor.IStandaloneEditorConstructionOptions = {
  automaticLayout: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  fontSize: 12.5,
  lineNumbers: 'on',
  lineNumbersMinChars: 3,
  glyphMargin: true,
  folding: false,
  renderLineHighlight: 'none',
  fontFamily: 'JetBrains Mono, Cascadia Code, Consolas, monospace',
};

export function mountThreePane(
  els: { ours: HTMLElement; result: HTMLElement; theirs: HTMLElement },
  init: ThreePaneInit,
): ThreePaneHandles {
  const lang = languageIdForPath(init.file);

  const make = (role: 'ours' | 'result' | 'theirs', value: string, readOnly: boolean): Pane => {
    const uri = monaco.Uri.from({ scheme: 'inmemory', path: `/merge-${role}/${init.file}` });
    monaco.editor.getModel(uri)?.dispose(); // stale model from a reopened tab
    const model = monaco.editor.createModel(value, lang, uri);
    const editor = monaco.editor.create(els[role], { ...BASE_OPTS, model, readOnly, theme: init.theme });
    return { model, editor };
  };

  const ours = make('ours', init.ours, true);
  const result = make('result', init.result, false);
  const theirs = make('theirs', init.theirs, true);

  return {
    ours,
    result,
    theirs,
    getResult: () => result.model.getValue(),
    dispose() {
      for (const pane of [ours, result, theirs]) {
        pane.editor.dispose();
        pane.model.dispose();
      }
    },
  };
}
