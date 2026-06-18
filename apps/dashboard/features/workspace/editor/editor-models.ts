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
import { modelPathFor, parseModelPath } from './editor-models-path.js';

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
// viewStates/mru são keyed pela CHAVE DO MODELO (uriKey = path namespaced, ex. `p5/src/x.ts`),
// para que abas de projetos diferentes com o mesmo path relativo não colidam.
const viewStates = new Map<string, MonacoNs.editor.ICodeEditorViewState | null>();
let mru: string[] = [];

/** Chave de registro do modelo: o path completo da URI (namespaced quando a flag está ON). */
function uriKeyOf(model: MonacoNs.editor.ITextModel): string {
  return model.uri.path.replace(/^\//, '');
}

/** Acha o modelo por (projectId, relpath) — projectId null (modelo não namespaced) casa por relpath. */
export function modelFor(projectId: number, relPath: string): MonacoNs.editor.ITextModel | null {
  if (!monacoRef) return null;
  return monacoRef.editor.getModels().find((m) => {
    const p = parseModelPath(m.uri.path);
    return p.relPath === relPath && (p.projectId === projectId || p.projectId === null) && !m.isDisposed();
  }) ?? null;
}

/** Acha o modelo pela chave de registro completa (uriKey). Usado pelo janitor + LRU. */
function modelByUriKey(uriKey: string): MonacoNs.editor.ITextModel | null {
  if (!monacoRef) return null;
  return monacoRef.editor.getModels().find((m) => uriKeyOf(m) === uriKey && !m.isDisposed()) ?? null;
}

/** Idempotent — first mount wires monaco + the closed-tab janitor. */
export function initEditorModels(monaco: Monaco): void {
  monacoRef = monaco;
  if (storeSubscribed) return;
  storeSubscribed = true;
  // Keyed por uriKey (modelPathFor) — abas de projetos diferentes com o mesmo path
  // relativo têm chaves distintas, então o setProject (que dropa as abas do projeto
  // que sai) dispõe os modelos do projeto antigo via este janitor.
  const openKeys = (): Set<string> =>
    new Set(
      useWorkspaceStore.getState().openFiles
        .filter((f) => f.kind === undefined || f.kind === 'file')
        .map((f) => modelPathFor(f.projectId, f.path)),
    );
  let prev = openKeys();
  useWorkspaceStore.subscribe(() => {
    const now = openKeys();
    for (const key of prev) {
      if (now.has(key)) continue;
      // Tab closed — free the model (undo stack included) + view state.
      modelByUriKey(key)?.dispose();
      viewStates.delete(key);
      mru = mru.filter((p) => p !== key);
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
export function touchModel(activeKey: string): void {
  mru = [activeKey, ...mru.filter((p) => p !== activeKey)];
  if (mru.length <= MAX_INACTIVE_MODELS + 1) return;
  for (const key of mru.slice(MAX_INACTIVE_MODELS + 1)) {
    if (key === activeKey) continue;
    // Keep the view state — re-opening restores cursor/scroll even though
    // the undo stack is gone (the price of bounded memory).
    modelByUriKey(key)?.dispose();
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
export function applyExternalContent(projectId: number, path: string, content: string, lastModified: string | null): void {
  const model = modelFor(projectId, path);
  if (model && model.getValue() !== content) {
    model.pushEditOperations(
      [],
      [{ range: model.getFullModelRange(), text: content }],
      () => null,
    );
  }
  useWorkspaceStore.getState().applyExternalContent(projectId, path, content, lastModified);
}
