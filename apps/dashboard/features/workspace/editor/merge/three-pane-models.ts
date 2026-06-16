/**
 * Imperative Monaco lifecycle for the 3-pane merge editor (Local |
 * Result | Incoming). Kept OUT of editor-models.ts on purpose: those are
 * the real-file models under a 20-model LRU; these are short-lived,
 * tab-scoped, and must be disposed deterministically on tab close.
 *
 * The synthetic URIs are prefixed (`/merge-<role>/…`) so they never alias
 * a real file path — editor-models' `relOf()`/`modelFor()` strip only the
 * leading slash, so an unprefixed URI could collide with an open file.
 */

import * as monaco from 'monaco-editor';
import { languageIdForPath } from '@mcp/shared/utils/language-id.js';

export interface ThreePaneInit {
  file: string;
  ours: string;
  theirs: string;
  merged: string;
  dark: boolean;
}

export interface ThreePaneHandles {
  resultEditor: monaco.editor.IStandaloneCodeEditor;
  getResult(): string;
  dispose(): void;
}

const BASE_OPTS: monaco.editor.IStandaloneEditorConstructionOptions = {
  automaticLayout: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  fontSize: 12.5,
  lineNumbers: 'on',
  renderLineHighlight: 'none',
  fontFamily: 'JetBrains Mono, Cascadia Code, Consolas, monospace',
};

export function mountThreePane(
  els: { ours: HTMLElement; result: HTMLElement; theirs: HTMLElement },
  init: ThreePaneInit,
): ThreePaneHandles {
  const lang = languageIdForPath(init.file);
  const theme = init.dark ? 'vs-dark' : 'vs';

  const make = (role: 'ours' | 'result' | 'theirs', value: string, readOnly: boolean) => {
    const uri = monaco.Uri.from({ scheme: 'inmemory', path: `/merge-${role}/${init.file}` });
    monaco.editor.getModel(uri)?.dispose(); // stale model from a reopened tab
    const model = monaco.editor.createModel(value, lang, uri);
    const editor = monaco.editor.create(els[role], { ...BASE_OPTS, model, readOnly, theme });
    return { model, editor };
  };

  const ours = make('ours', init.ours, true);
  const result = make('result', init.merged, false);
  const theirs = make('theirs', init.theirs, true);

  return {
    resultEditor: result.editor,
    getResult: () => result.model.getValue(),
    dispose() {
      for (const pane of [ours, result, theirs]) {
        pane.editor.dispose();
        pane.model.dispose();
      }
    },
  };
}
