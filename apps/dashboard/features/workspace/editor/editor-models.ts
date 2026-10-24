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
/** Full-buffer mirrors are a persistence fallback; Monaco remains authoritative while live. */
export const EDITOR_CONTENT_MIRROR_DELAY_MS = 400;

let monacoRef: Monaco | null = null;
let activeEditor: MonacoNs.editor.IStandaloneCodeEditor | null = null;
let storeSubscribed = false;
const externalContentPatches = new WeakSet<MonacoNs.editor.ITextModel>();
const pendingContentMirrors = new WeakMap<MonacoNs.editor.ITextModel, {
  timer: ReturnType<typeof setTimeout>;
  projectId: number;
  path: string;
}>();

function modelIdentity(model: MonacoNs.editor.ITextModel): { projectId: number; path: string; dirty: boolean } | null {
  const parsed = parseModelPath(model.uri.path);
  const state = useWorkspaceStore.getState();
  // Bare model URIs are the runtime rollback mode. The workspace holds a
  // single project's tabs, so its active project is the safe fallback.
  const projectId = parsed.projectId ?? state.activeProjectId;
  if (projectId === null) return null;
  const tab = state.openFiles.find((candidate) =>
    (candidate.kind === undefined || candidate.kind === 'file')
    && candidate.projectId === projectId
    && candidate.path === parsed.relPath);
  if (!tab || (tab.kind && tab.kind !== 'file')) return null;
  return { projectId, path: parsed.relPath, dirty: tab.dirty };
}

function mirrorModelContent(
  model: MonacoNs.editor.ITextModel,
  identity: { projectId: number; path: string },
): void {
  try {
    if (model.isDisposed()) return;
    useWorkspaceStore.getState().syncEditorContent(identity.projectId, identity.path, model.getValue());
  } catch {
    // Model/editor disposal can race the trailing debounce during navigation.
  }
}

function discardEditorContentMirror(model: MonacoNs.editor.ITextModel): void {
  const pending = pendingContentMirrors.get(model);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingContentMirrors.delete(model);
}

/**
 * Record a real Monaco edit without calling `getValue()` on the hot keystroke
 * path. Dirty metadata updates immediately; the full store fallback catches up
 * once typing pauses.
 */
export function recordEditorContentChange(model: MonacoNs.editor.ITextModel): void {
  if (isApplyingExternalContent(model)) return;
  const identity = modelIdentity(model);
  if (!identity) return;
  if (!identity.dirty) useWorkspaceStore.getState().markEditorDirty(identity.projectId, identity.path);

  discardEditorContentMirror(model);
  const timer = setTimeout(() => {
    pendingContentMirrors.delete(model);
    mirrorModelContent(model, identity);
  }, EDITOR_CONTENT_MIRROR_DELAY_MS);
  pendingContentMirrors.set(model, { timer, projectId: identity.projectId, path: identity.path });
}

/** Commit a pending fallback mirror before an editor/model is released. */
export function flushEditorContentMirror(model: MonacoNs.editor.ITextModel | null): void {
  if (!model) return;
  const pending = pendingContentMirrors.get(model);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingContentMirrors.delete(model);
  mirrorModelContent(model, pending);
}

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
  const openKeys = (state: ReturnType<typeof useWorkspaceStore.getState>): string[] =>
    state.openFiles
      .filter((f) => f.kind === undefined || f.kind === 'file')
      .map((f) => modelPathFor(f.projectId, f.path));
  let prev = openKeys(useWorkspaceStore.getState());
  useWorkspaceStore.subscribe((state) => {
    const next = openKeys(state);
    if (next.length === prev.length && next.every((key, index) => key === prev[index])) return;
    const now = new Set(next);
    for (const key of prev) {
      if (now.has(key)) continue;
      // Tab closed — free the model (undo stack included) + view state.
      const model = modelByUriKey(key);
      if (model) {
        discardEditorContentMirror(model);
        model.dispose();
      }
      viewStates.delete(key);
      mru = mru.filter((p) => p !== key);
    }
    prev = next;
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
  const survivors = mru.slice(0, MAX_INACTIVE_MODELS + 1);
  for (const key of mru.slice(MAX_INACTIVE_MODELS + 1)) {
    if (key === activeKey) {
      survivors.push(key);
      continue;
    }
    const model = modelByUriKey(key);
    // Never evict a model a live editor is currently rendering — in a split
    // the OTHER pane shows a different model, and disposing it under a live
    // editor blanks that pane + tears down its LSP buffer (documentSync
    // didClose). Keep it tracked so it's reconsidered once it's detached.
    if (model && model.isAttachedToEditor()) {
      survivors.push(key);
      continue;
    }
    // Keep the view state — re-opening restores cursor/scroll even though
    // the undo stack is gone (the price of bounded memory).
    if (model) {
      // The store mirror may still be trailing the last edit. Commit it before
      // disposing the authoritative model so save/reopen fallbacks stay safe.
      flushEditorContentMirror(model);
      model.dispose();
    }
  }
  mru = survivors;
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

/** True only during the synchronous model patch performed below. */
function isApplyingExternalContent(model: MonacoNs.editor.ITextModel | null): boolean {
  return model !== null && externalContentPatches.has(model);
}

/**
 * External (disk) content for a tab: patch the live model preserving undo,
 * mirror into the store. Single entry point used by the fetch-on-activate
 * hook and the fs-events reload path.
 */
export function applyExternalContent(projectId: number, path: string, content: string, lastModified: string | null): void {
  const model = modelFor(projectId, path);
  if (model && model.getValue() !== content) {
    // An explicit disk reload supersedes any trailing user-edit mirror.
    discardEditorContentMirror(model);
    externalContentPatches.add(model);
    try {
      model.pushEditOperations(
        [],
        [{ range: model.getFullModelRange(), text: content }],
        () => null,
      );
    } finally {
      externalContentPatches.delete(model);
    }
  }
  useWorkspaceStore.getState().applyExternalContent(projectId, path, content, lastModified);
}
