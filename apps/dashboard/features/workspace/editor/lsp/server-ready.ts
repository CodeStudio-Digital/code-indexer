/** Shared project-scoped LSP-ready signal for semantic tokens and Code Vision. */
import type * as MonacoNs from 'monaco-editor';
import { apiStream, electronApi } from '../../../../lib/api-client.js';

interface ServerReadyFrame {
  languageId: string;
  state: string;
}

type Listener = (frame: ServerReadyFrame) => void;
const listeners = new Map<number, Set<Listener>>();

export function onLspServerReady(projectId: number, listener: Listener): MonacoNs.IDisposable {
  let set = listeners.get(projectId);
  if (!set) {
    set = new Set();
    listeners.set(projectId, set);
  }
  set.add(listener);
  return {
    dispose() {
      set?.delete(listener);
      if (set?.size === 0) listeners.delete(projectId);
    },
  };
}

function emit(projectId: number, frame: ServerReadyFrame): void {
  if (frame.state !== 'ready') return;
  for (const listener of listeners.get(projectId) ?? []) {
    try { listener(frame); } catch { /* one visual consumer must not starve the others */ }
  }
}

/** One transport per provider registration; all visual consumers share it. */
export function startLspServerReadyStream(projectId: number): MonacoNs.IDisposable {
  let stopped = false;
  let es: EventSource | null = null;
  let closeIterator: (() => void) | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = (): void => {
    if (stopped) return;
    if (electronApi()) {
      const iterator = apiStream<ServerReadyFrame>('lsp.serverStatusStream', { projectId })[Symbol.asyncIterator]();
      closeIterator = () => { void iterator.return?.(); };
      void (async () => {
        try {
          while (!stopped) {
            const result = await iterator.next();
            if (result.done || stopped) break;
            emit(projectId, result.value);
          }
        } catch {
          /* reconnect below */
        }
        if (!stopped) retryTimer = setTimeout(connect, 2000);
      })();
      return;
    }

    // SSR and focused Node/Vitest runs have neither the Electron bridge nor
    // the browser EventSource primitive. Provider registration must remain a
    // harmless no-op there instead of failing the whole editor bootstrap.
    if (typeof EventSource === 'undefined') return;
    es = new EventSource(`/api/lsp/${projectId}/server-status/stream`);
    es.addEventListener('serverStatus', (event) => {
      if (stopped) return;
      try { emit(projectId, JSON.parse((event as MessageEvent).data) as ServerReadyFrame); } catch { /* malformed frame */ }
    });
  };
  connect();

  return {
    dispose() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      closeIterator?.();
      es?.close();
    },
  };
}

/** Test-only: exercise visual invalidation without opening a transport. */
export function __emitLspServerReadyForTests(projectId: number, languageId = 'php'): void {
  emit(projectId, { languageId, state: 'ready' });
}
