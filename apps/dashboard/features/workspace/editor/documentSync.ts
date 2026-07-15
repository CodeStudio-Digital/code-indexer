/**
 * Monaco model lifecycle → backend document store (didOpen/didChange/didClose).
 *
 * Every synchronizer owns a unique syncSessionId. This makes teardown safe:
 * delayed changes/closes from an obsolete provider generation cannot mutate the
 * buffer opened by a newer generation after project switches, HMR or restores.
 */
import type * as MonacoNs from 'monaco-editor';
import { apiCall } from '../../../lib/api-client.js';
import { languageIdForDocument } from '@mcp/shared/utils/language-id.js';
import { parseModelPath } from './editor-models-path.js';
import { incrementLspCounter } from './lsp-log.js';

type Monaco = typeof MonacoNs;

const FLUSH_MS = 16;
let nextSessionSequence = 0;

interface DocChangeDTO {
  range: { start: { line: number; column: number }; end: { line: number; column: number } };
  rangeOffset: number;
  rangeLength: number;
  text: string;
}

interface ModelState {
  model: MonacoNs.editor.ITextModel;
  rel: string;
  pending: DocChangeDTO[];
  timer: ReturnType<typeof setTimeout> | null;
  disposers: MonacoNs.IDisposable[];
  closed: boolean;
}

function sessionId(): string {
  const stamp = Date.now().toString(36).padStart(10, '0');
  const sequence = (nextSessionSequence++).toString(36).padStart(6, '0');
  let random = Math.random().toString(36).slice(2);
  try { random = crypto.randomUUID(); } catch { /* Math.random suffix is sufficient for uniqueness here. */ }
  // The fixed-width timestamp/sequence prefix is sortable. The backend keeps
  // a tombstone for the newest session so even a delayed old didOpen is stale.
  return `${stamp}-${sequence}-${random}`;
}

function ownedModel(model: MonacoNs.editor.ITextModel, projectId: number): { rel: string } | null {
  const parsed = parseModelPath(model.uri.path);
  // Namespaced model URIs are the ownership boundary. Preview/diff/legacy bare
  // models are deliberately ignored instead of leaking one project's provider
  // into another project that happens to share the same relative path.
  if (parsed.projectId !== projectId || !parsed.relPath) return null;
  return { rel: parsed.relPath };
}

export interface DocumentSync extends MonacoNs.IDisposable {
  /** Attach (including restored pre-existing models), drain changes and await delivery. */
  ensureSynced(model: MonacoNs.editor.ITextModel): Promise<void>;
  /** Backward-compatible path drain for provider modules migrated incrementally. */
  flush(rel: string): Promise<void>;
}

const activeSynchronizers = new Map<number, DocumentSync>();

/** Commands outside Monaco's provider registry (organize imports, Code Vision). */
export function ensureDocumentSynced(projectId: number, model: MonacoNs.editor.ITextModel): Promise<void> {
  return activeSynchronizers.get(projectId)?.ensureSynced(model) ?? Promise.resolve();
}

export function startDocumentSync(monaco: Monaco, projectId: number): DocumentSync {
  const syncSessionId = sessionId();
  const perModel = new Map<string, ModelState>();
  const byRel = new Map<string, ModelState>();
  const chains = new Map<string, Promise<void>>();
  let accepting = true;

  const enqueue = (rel: string, task: () => Promise<void>): void => {
    const prev = chains.get(rel) ?? Promise.resolve();
    const next = prev.then(task, task).catch(() => undefined);
    chains.set(rel, next);
  };

  const sendOpen = (state: ModelState): void => {
    const { model, rel } = state;
    if (state.closed || model.isDisposed()) return;
    const languageId = languageIdForDocument(rel, model.getValue());
    const version = model.getVersionId();
    const content = model.getValue();
    enqueue(rel, async () => {
      await apiCall('lsp.didOpen', {
        projectId,
        file: rel,
        languageId,
        version,
        content,
        syncSessionId,
      });
    });
  };

  const cancelTimer = (state: ModelState): void => {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
  };

  const flushState = (state: ModelState): void => {
    cancelTimer(state);
    if (state.pending.length === 0 || state.model.isDisposed() || state.closed) return;
    const changes = state.pending;
    state.pending = [];
    const version = state.model.getVersionId();
    enqueue(state.rel, async () => {
      const res = await apiCall<{ ok?: true; resync?: true }>('lsp.didChange', {
        projectId,
        file: state.rel,
        version,
        changes,
        syncSessionId,
      });
      if (res?.resync && !state.model.isDisposed() && !state.closed) {
        incrementLspCounter('resync');
        sendOpen(state);
      }
    });
  };

  const closeState = (state: ModelState): void => {
    if (state.closed) return;
    flushState(state);
    state.closed = true;
    cancelTimer(state);
    state.disposers.forEach((d) => d.dispose());
    perModel.delete(state.model.uri.toString());
    if (byRel.get(state.rel) === state) byRel.delete(state.rel);
    enqueue(state.rel, async () => {
      await apiCall('lsp.didClose', { projectId, file: state.rel, syncSessionId });
    });
  };

  const attach = (model: MonacoNs.editor.ITextModel): ModelState | null => {
    const key = model.uri.toString();
    const current = perModel.get(key);
    if (current) return current;
    if (!accepting || model.isDisposed()) return null;
    const owned = ownedModel(model, projectId);
    if (!owned) return null;

    const state: ModelState = {
      model,
      rel: owned.rel,
      pending: [],
      timer: null,
      disposers: [],
      closed: false,
    };
    state.disposers.push(
      model.onDidChangeContent((event) => {
        if (!accepting || state.closed) return;
        for (const change of event.changes) {
          state.pending.push({
            range: {
              start: { line: change.range.startLineNumber, column: change.range.startColumn },
              end: { line: change.range.endLineNumber, column: change.range.endColumn },
            },
            rangeOffset: change.rangeOffset,
            rangeLength: change.rangeLength,
            text: change.text,
          });
        }
        if (!state.timer) state.timer = setTimeout(() => flushState(state), FLUSH_MS);
      }),
      model.onWillDispose(() => closeState(state)),
    );
    perModel.set(key, state);
    byRel.set(state.rel, state);
    sendOpen(state);
    return state;
  };

  const createSub = monaco.editor.onDidCreateModel((model) => { attach(model); });
  // Restored models already exist before providers mount. Reconcile all of them
  // now; ensureSynced repeats this on demand to close any remaining timing gap.
  for (const model of monaco.editor.getModels()) attach(model);

  const synchronizer: DocumentSync = {
    dispose() {
      if (!accepting) return;
      accepting = false;
      if (activeSynchronizers.get(projectId) === synchronizer) activeSynchronizers.delete(projectId);
      createSub.dispose();
      // Drain first, then enqueue close. Session ownership makes these async
      // closes harmless if a newer generation opens the same URI meanwhile.
      for (const state of [...perModel.values()]) closeState(state);
    },
    async ensureSynced(model: MonacoNs.editor.ITextModel): Promise<void> {
      const state = attach(model);
      if (!state) return;
      flushState(state);
      await (chains.get(state.rel) ?? Promise.resolve());
    },
    async flush(rel: string): Promise<void> {
      const state = byRel.get(rel);
      if (state) flushState(state);
      await (chains.get(rel) ?? Promise.resolve());
    },
  };
  activeSynchronizers.set(projectId, synchronizer);
  return synchronizer;
}
