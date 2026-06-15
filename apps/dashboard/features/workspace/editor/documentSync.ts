/**
 * Monaco model lifecycle → backend document store (didOpen/didChange/
 * didClose). After this, position-based LSP calls send only {file, position}
 * — the full-buffer-per-keystroke payload is gone.
 *
 * Correctness notes:
 *  - Change events are microbatched (16ms) and CONCATENATED in event order:
 *    each event's changes refer to its own pre-event buffer, and the backend
 *    applies the array sequentially — composition holds.
 *  - Sends are SERIALIZED per file (promise chain): HTTP/IPC give no
 *    cross-request ordering guarantee, and an out-of-order didChange would
 *    corrupt the backend buffer (it answers {resync} on version gaps, but
 *    serializing avoids paying that constantly).
 *  - {resync:true} → full didOpen with the current model text.
 *  - Only models that correspond to an open workspace FILE tab are synced —
 *    diff/preview models stay out of the backend store.
 */
import type * as MonacoNs from 'monaco-editor';
import { apiCall } from '../../../lib/api-client.js';
import { languageIdForPath } from '@mcp/shared/utils/language-id.js';

type Monaco = typeof MonacoNs;

const FLUSH_MS = 16;

interface DocChangeDTO {
  range: { start: { line: number; column: number }; end: { line: number; column: number } };
  rangeOffset: number;
  rangeLength: number;
  text: string;
}

function relOf(model: MonacoNs.editor.ITextModel): string {
  return model.uri.path.replace(/^\//, '');
}

async function isWorkspaceFile(rel: string, projectId: number): Promise<boolean> {
  const { useWorkspaceStore } = await import('../../../state/workspace.js');
  return useWorkspaceStore
    .getState()
    .openFiles.some((f) => f.kind === 'file' && f.path === rel && f.projectId === projectId);
}

export function startDocumentSync(monaco: Monaco, projectId: number): MonacoNs.IDisposable {
  const perModel = new Map<string, MonacoNs.IDisposable[]>();
  // Per-file send chain — serializes didOpen/didChange/didClose.
  const chains = new Map<string, Promise<void>>();
  let stopped = false;

  const enqueue = (rel: string, task: () => Promise<void>): void => {
    const prev = chains.get(rel) ?? Promise.resolve();
    const next = prev.then(task, task).catch(() => undefined);
    chains.set(rel, next);
  };

  const sendOpen = (model: MonacoNs.editor.ITextModel, rel: string): void => {
    enqueue(rel, async () => {
      if (stopped || model.isDisposed()) return;
      await apiCall('lsp.didOpen', {
        projectId,
        file: rel,
        languageId: languageIdForPath(rel),
        version: model.getVersionId(),
        content: model.getValue(),
      });
    });
  };

  const attach = async (model: MonacoNs.editor.ITextModel): Promise<void> => {
    const rel = relOf(model);
    if (!rel || perModel.has(rel)) return;
    if (!(await isWorkspaceFile(rel, projectId))) return;
    if (stopped || model.isDisposed()) return;

    let pending: DocChangeDTO[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = (): void => {
      timer = null;
      if (pending.length === 0 || model.isDisposed()) return;
      const changes = pending;
      pending = [];
      const version = model.getVersionId();
      enqueue(rel, async () => {
        if (stopped) return;
        const res = await apiCall<{ ok?: true; resync?: true }>('lsp.didChange', {
          projectId, file: rel, version, changes,
        });
        if (res?.resync && !model.isDisposed()) sendOpen(model, rel);
      });
    };

    const disposers: MonacoNs.IDisposable[] = [
      model.onDidChangeContent((e) => {
        for (const c of e.changes) {
          pending.push({
            range: {
              start: { line: c.range.startLineNumber, column: c.range.startColumn },
              end: { line: c.range.endLineNumber, column: c.range.endColumn },
            },
            rangeOffset: c.rangeOffset,
            rangeLength: c.rangeLength,
            text: c.text,
          });
        }
        if (!timer) timer = setTimeout(flush, FLUSH_MS);
      }),
      model.onWillDispose(() => {
        if (timer) { clearTimeout(timer); timer = null; }
        pending = [];
        perModel.get(rel)?.forEach((d) => d.dispose());
        perModel.delete(rel);
        enqueue(rel, async () => {
          if (stopped) return;
          await apiCall('lsp.didClose', { projectId, file: rel });
        });
      }),
    ];
    perModel.set(rel, disposers);
    sendOpen(model, rel);
  };

  const createSub = monaco.editor.onDidCreateModel((m) => void attach(m));
  for (const m of monaco.editor.getModels()) void attach(m);

  return {
    dispose() {
      stopped = true;
      createSub.dispose();
      for (const disposers of perModel.values()) disposers.forEach((d) => d.dispose());
      perModel.clear();
    },
  };
}
