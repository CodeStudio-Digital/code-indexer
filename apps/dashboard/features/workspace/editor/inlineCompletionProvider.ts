/**
 * AI ghost-text — Monaco inline completions backed by `editor.complete`
 * (pipeline binding editor/autocomplete, admin-configured).
 *
 * Cost guardrails, in gate order: feature toggle (localStorage, default
 * OFF) → snooze window (unconfigured 5min / provider errors per server
 * retryAfterMs) → suggest-widget-open skip → debounce (server-suggested,
 * default 300ms) with CancellationToken. The server adds single-flight +
 * result cache on top — a keystroke burst costs at most one provider call.
 */
import { create } from 'zustand';
import type * as MonacoNs from 'monaco-editor';
import { apiCall } from '../../../lib/api-client.js';
import type { EditorCompleteResult } from '@mcp/api-bus';
import { logLsp } from './lsp-log.js';
import { parseModelPath } from './editor-models-path.js';

type Monaco = typeof MonacoNs;

const TOGGLE_KEY = 'mcp-ide:ai-complete';
const UNCONFIGURED_SNOOZE_MS = 5 * 60_000;
const TIMEOUT_SNOOZE_MS = 15_000;

export interface AiCompleteIssue {
  kind: 'unconfigured' | 'timeout' | 'provider_error';
  /** Human-readable cause from the server (model name, suggested fix). */
  message?: string;
}

interface AiCompleteState {
  enabled: boolean;
  busy: boolean;
  /** Last failure — the chip surfaces it so silent snoozes stay explainable. */
  issue: AiCompleteIssue | null;
  setEnabled: (on: boolean) => void;
  setBusy: (busy: boolean) => void;
  setIssue: (issue: AiCompleteIssue | null) => void;
}

export const useAiCompleteStore = create<AiCompleteState>((set) => ({
  enabled: typeof localStorage !== 'undefined' && localStorage.getItem(TOGGLE_KEY) === '1',
  busy: false,
  issue: null,
  setEnabled: (on) => {
    try { localStorage.setItem(TOGGLE_KEY, on ? '1' : '0'); } catch { /* private mode */ }
    // Re-enabling resets the snooze so the user gets immediate feedback.
    if (on) snoozedUntil = 0;
    set({ enabled: on, issue: null });
  },
  setBusy: (busy) => set({ busy }),
  setIssue: (issue) => set({ issue }),
}));

let snoozedUntil = 0;
let serverDebounceMs = 300;
let acceptCommandRegistered = false;

/** Debounce that resolves false when Monaco cancels the request mid-wait. */
function debounceWait(ms: number, token: MonacoNs.CancellationToken): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(true), ms);
    token.onCancellationRequested(() => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export function registerInlineCompletions(monaco: Monaco, projectId: number): MonacoNs.IDisposable {
  // Accept-rate telemetry: Monaco runs the item's `command` on accept.
  if (!acceptCommandRegistered) {
    acceptCommandRegistered = true;
    monaco.editor.registerCommand('mcp.aiComplete.accepted', (_accessor, requestId: string) => {
      void apiCall('editor.feedback', { projectId, requestId, action: 'accept' }).catch(() => undefined);
    });
  }

  return monaco.languages.registerInlineCompletionsProvider('*', {
    async provideInlineCompletions(model, position, context, token) {
      const empty = { items: [] as MonacoNs.languages.InlineCompletion[] };
      const store = useAiCompleteStore.getState();
      if (!store.enabled) return empty;
      if (Date.now() < snoozedUntil) return empty;
      // The suggest widget already owns the keystroke — ghost text on top
      // of it is noise (and doubles the spend).
      if (context.selectedSuggestionInfo) return empty;

      if (!(await debounceWait(serverDebounceMs, token))) return empty;
      if (token.isCancellationRequested) return empty;

      const startLine = Math.max(1, position.lineNumber - 79);
      const endLine = Math.min(model.getLineCount(), position.lineNumber + 30);
      const prefix = model.getValueInRange(
        new monaco.Range(startLine, 1, position.lineNumber, position.column),
      );
      const suffix = model.getValueInRange(
        new monaco.Range(position.lineNumber, position.column, endLine, model.getLineMaxColumn(endLine)),
      );
      if (prefix.trim().length === 0 && suffix.trim().length === 0) return empty;

      useAiCompleteStore.getState().setBusy(true);
      try {
        const res = await apiCall<EditorCompleteResult>('editor.complete', {
          projectId,
          file: parseModelPath(model.uri.path).relPath,
          language: model.getLanguageId(),
          position: { line: position.lineNumber, col: position.column },
          prefix,
          suffix,
        });
        if (res.debounceMs && res.debounceMs > 0) serverDebounceMs = res.debounceMs;

        if (res.status === 'unconfigured') {
          snoozedUntil = Date.now() + UNCONFIGURED_SNOOZE_MS;
          useAiCompleteStore.getState().setIssue({ kind: 'unconfigured' });
          return empty;
        }
        if (res.status === 'timeout') {
          snoozedUntil = Date.now() + TIMEOUT_SNOOZE_MS;
          useAiCompleteStore.getState().setIssue({ kind: 'timeout', message: res.message });
          return empty;
        }
        if (res.status === 'provider_error') {
          snoozedUntil = Date.now() + (res.retryAfterMs ?? 60_000);
          useAiCompleteStore.getState().setIssue({ kind: 'provider_error', message: res.message });
          return empty;
        }
        if (res.status !== 'ok' || !res.text || token.isCancellationRequested) return empty;

        useAiCompleteStore.getState().setIssue(null);
        return {
          items: [
            {
              insertText: res.text,
              // COLLAPSED range = pure insertion at the cursor. Without it
              // Monaco defaults to replacing word-start..END-OF-LINE and only
              // renders ghost text when the already-typed text is a prefix of
              // insertText — our server trims that echo away, so every
              // completion was silently filtered (never rendered).
              range: new monaco.Range(
                position.lineNumber, position.column, position.lineNumber, position.column,
              ),
              command: res.requestId
                ? { id: 'mcp.aiComplete.accepted', title: 'accepted', arguments: [res.requestId] }
                : undefined,
            },
          ],
          enableForwardStability: true,
        };
      } catch (err) {
        logLsp({ op: 'inline', file: parseModelPath(model.uri.path).relPath, lang: model.getLanguageId(),
                 outcome: 'threw', err: err instanceof Error ? err.message : String(err) });
        snoozedUntil = Date.now() + 30_000;
        return empty;
      } finally {
        useAiCompleteStore.getState().setBusy(false);
      }
    },
    freeInlineCompletions() {
      /* nothing retained per batch */
    },
  });
}
