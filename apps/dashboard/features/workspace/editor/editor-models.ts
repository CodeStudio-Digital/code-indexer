/**
 * Live-model registry for the multi-model editor (keepCurrentModel mode).
 *
 *  - viewStates survive editor UNMOUNTS (tab → diff/welcome → back keeps
 *    cursor/scroll/selection; while mounted, @monaco-editor/react already
 *    handles per-path swaps).
 *  - LRU keeps at most N non-active models alive (each holds full text +
 *    undo stack); evicted models dispose → documentSync didClose fires →
 *    backend buffers stay in lockstep.
 *  - applyExternalContent patches the LIVE model with pushEditOperations
 *    (undo stack preserved) and mirrors into the workspace store.
 *  - A store subscription disposes models/viewStates of closed tabs.
 */
import type * as MonacoNs from 'monaco-editor';
import { useWorkspaceStore } from '../../../state/workspace.js';

type Monaco = typeof MonacoNs;

const MAX_INACTIVE_MODELS = 20;

let monacoRef: Monaco | null = null;
let activeEditor: MonacoNs.editor.IStandaloneCodeEditor | null = null;
let storeSubscribed = false;

/** The mounted editor instance (commands: go-to-line, format, …). */
export function setActiveEditor(editor: MonacoNs.editor.IStandaloneCodeEditor | null): void {
  activeEditor = editor;
}
export function getActiveEditor(): MonacoNs.editor.IStandaloneCodeEditor | null {
  return activeEditor;
}
const viewStates = new Map<string, MonacoNs.editor.ICodeEditorViewState | null>();
/** MRU list of model paths (most recent first). */
let mru: string[] = [];

function relOf(model: MonacoNs.editor.ITextModel): string {
  return model.uri.path.replace(/^\//, '');
}

export function modelFor(path: string): MonacoNs.editor.ITextModel | null {
  if (!monacoRef) return null;
  return monacoRef.editor.getModels().find((m) => relOf(m) === path && !m.isDisposed()) ?? null;
}

/** Idempotent — first mount wires monaco + the closed-tab janitor. */
export function initEditorModels(monaco: Monaco): void {
  monacoRef = monaco;
  if (storeSubscribed) return;
  storeSubscribed = true;
  let prev = new Set(
    useWorkspaceStore.getState().openFiles
      .filter((f) => f.kind === undefined || f.kind === 'file')
      .map((f) => f.path),
  );
  useWorkspaceStore.subscribe((state) => {
    const now = new Set(
      state.openFiles
        .filter((f) => f.kind === undefined || f.kind === 'file')
        .map((f) => f.path),
    );
    for (const path of prev) {
      if (now.has(path)) continue;
      // Tab closed — free the model (undo stack included) + view state.
      modelFor(path)?.dispose();
      viewStates.delete(path);
      mru = mru.filter((p) => p !== path);
    }
    prev = now;
  });
}

export function saveViewStateFor(path: string, editor: MonacoNs.editor.IStandaloneCodeEditor): void {
  try { viewStates.set(path, editor.saveViewState()); } catch { /* disposed editor */ }
}

export function restoreViewStateFor(path: string, editor: MonacoNs.editor.IStandaloneCodeEditor): void {
  const vs = viewStates.get(path);
  if (vs) {
    try { editor.restoreViewState(vs); } catch { /* model swapped */ }
  }
}

/** Bump MRU for the ACTIVE path and evict cold models beyond the cap. */
export function touchModel(activePath: string): void {
  mru = [activePath, ...mru.filter((p) => p !== activePath)];
  if (mru.length <= MAX_INACTIVE_MODELS + 1) return;
  for (const path of mru.slice(MAX_INACTIVE_MODELS + 1)) {
    if (path === activePath) continue;
    const model = modelFor(path);
    if (model) {
      // Keep the view state — re-opening restores cursor/scroll even though
      // the undo stack is gone (the price of bounded memory).
      model.dispose();
    }
  }
  mru = mru.slice(0, MAX_INACTIVE_MODELS + 1);
}

/** Perf-monitor introspection: live Monaco models + total buffered chars. */
export function getModelStats(): { models: number; totalChars: number; viewStates: number } {
  const models = monacoRef?.editor.getModels().filter((m) => !m.isDisposed()) ?? [];
  let totalChars = 0;
  for (const m of models) {
    try { totalChars += m.getValueLength(); } catch { /* disposed mid-walk */ }
  }
  return { models: models.length, totalChars, viewStates: viewStates.size };
}

/**
 * External (disk) content for a tab: patch the live model preserving undo,
 * mirror into the store. Single entry point used by the fetch-on-activate
 * hook and the fs-events reload path.
 */
export function applyExternalContent(path: string, content: string, lastModified: string | null): void {
  const model = modelFor(path);
  if (model && model.getValue() !== content) {
    model.pushEditOperations(
      [],
      [{ range: model.getFullModelRange(), text: content }],
      () => null,
    );
  }
  useWorkspaceStore.getState().applyExternalContent(path, content, lastModified);
}
