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
import { shouldSkipCompletion, type Suppression } from '@mcp/shared/editor/completion-prefilter.js';
import { logLsp } from './lsp-log.js';
import { parseModelPath } from './editor-models-path.js';
import { recordShownCompletion, tryForwardCompletion } from './completionForwardCache.js';
import { consumeForceProvide } from './ai-complete-commands.js';
import { noteShown, notePartial, noteAccept, noteFreed, anyTracked } from './aiCompleteFeedback.js';

type Monaco = typeof MonacoNs;

const TOGGLE_KEY = 'mcp-ide:ai-complete';
const UNCONFIGURED_SNOOZE_MS = 5 * 60_000;
const TIMEOUT_SNOOZE_MS = 15_000;
const PREFILTER_REPORT_MS = 60_000;

export interface AiCompleteIssue {
  kind: 'unconfigured' | 'timeout' | 'provider_error';
  /** Human-readable cause from the server (model name, suggested fix). */
  message?: string;
}

/** One-shot chip popover: setup CTA or "how to enable" hint. */
export type AiCompleteNudge = 'unconfigured' | 'enable-hint' | 'enabled-hint' | null;

interface AiCompleteState {
  enabled: boolean;
  busy: boolean;
  /** Last failure — the chip surfaces it so silent snoozes stay explainable. */
  issue: AiCompleteIssue | null;
  /** Ghost text currently on screen (chip pulse affordance). */
  suggestionVisible: boolean;
  nudge: AiCompleteNudge;
  setEnabled: (on: boolean) => void;
  setBusy: (busy: boolean) => void;
  setIssue: (issue: AiCompleteIssue | null) => void;
  setSuggestionVisible: (visible: boolean) => void;
  requestNudge: (nudge: AiCompleteNudge) => void;
}

/**
 * True when the user never touched the toggle — the guided setup flow
 * auto-enables ONLY in that case (an explicit '0' is an explicit no).
 */
export function aiCompleteToggleUnset(): boolean {
  try { return localStorage.getItem(TOGGLE_KEY) === null; } catch { return false; }
}

export const useAiCompleteStore = create<AiCompleteState>((set) => ({
  enabled: typeof localStorage !== 'undefined' && localStorage.getItem(TOGGLE_KEY) === '1',
  busy: false,
  issue: null,
  suggestionVisible: false,
  nudge: null,
  setEnabled: (on) => {
    try { localStorage.setItem(TOGGLE_KEY, on ? '1' : '0'); } catch { /* private mode */ }
    // Re-enabling resets the snooze so the user gets immediate feedback.
    if (on) snoozedUntil = 0;
    set({ enabled: on, issue: null, nudge: null });
  },
  setBusy: (busy) => set({ busy }),
  setIssue: (issue) => set({ issue }),
  setSuggestionVisible: (visible) => set({ suggestionVisible: visible }),
  requestNudge: (nudge) => set({ nudge }),
}));

let snoozedUntil = 0;
let serverDebounceMs = 300;
let serverSuppression: Suppression = 'standard';
let acceptCommandRegistered = false;

// Prefilter skip telemetry — accumulated per rule, flushed at most 1/min.
const prefilterSkips = new Map<string, number>();
let prefilterLastReport = 0;

function notePrefilterSkip(projectId: number, rule: string): void {
  prefilterSkips.set(rule, (prefilterSkips.get(rule) ?? 0) + 1);
  const now = Date.now();
  if (now - prefilterLastReport < PREFILTER_REPORT_MS) return;
  prefilterLastReport = now;
  const detail = [...prefilterSkips.entries()].map(([r, n]) => `${r}:${n}`).join(',');
  prefilterSkips.clear();
  void apiCall('editor.feedback', { projectId, action: 'prefilter_skip', detail }).catch(() => undefined);
}

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
  // Accept telemetry: Monaco runs the item's `command` on full accept.
  if (!acceptCommandRegistered) {
    acceptCommandRegistered = true;
    monaco.editor.registerCommand('mcp.aiComplete.accepted', (_accessor, requestId: string) => {
      noteAccept(projectId, requestId);
    });
  }

  return monaco.languages.registerInlineCompletionsProvider('*', {
    async provideInlineCompletions(model, position, context, token) {
      const empty = { items: [] as MonacoNs.languages.InlineCompletion[] };
      const store = useAiCompleteStore.getState();
      // Manual trigger (Alt+\ → inlineSuggest.trigger) bypasses snooze,
      // suggest-widget gate, prefilter and debounce — explicit intent.
      const explicit = context.triggerKind === monaco.languages.InlineCompletionTriggerKind.Explicit
        || consumeForceProvide();
      if (!store.enabled) return empty;
      if (explicit) {
        snoozedUntil = 0; // manual retry re-probes after errors
      } else {
        if (Date.now() < snoozedUntil) return empty;
        // The suggest widget already owns the keystroke — ghost text on top
        // of it is noise (and doubles the spend).
        if (context.selectedSuggestionInfo) return empty;
      }

      const relPath = parseModelPath(model.uri.path).relPath;
      const forwardKey = `${projectId}:${relPath}`;

      // Typing forward through the last shown completion → serve the
      // remainder instantly (no debounce, no RPC, no spinner).
      const fwd = tryForwardCompletion(
        forwardKey, position.lineNumber, position.column,
        (fromCol) => model.getValueInRange(
          new monaco.Range(position.lineNumber, fromCol, position.lineNumber, position.column),
        ),
      );
      if (fwd) {
        recordShownCompletion(forwardKey, position.lineNumber, position.column, fwd.text, fwd.requestId);
        return {
          items: [{
            insertText: fwd.text,
            range: new monaco.Range(
              position.lineNumber, position.column, position.lineNumber, position.column,
            ),
            command: fwd.requestId
              ? { id: 'mcp.aiComplete.accepted', title: 'accepted', arguments: [fwd.requestId] }
              : undefined,
            // Custom prop — Monaco hands the SAME object back in the
            // show/partial/free callbacks below.
            _requestId: fwd.requestId,
          } as MonacoNs.languages.InlineCompletion],
          enableForwardStability: true,
        };
      }

      // Deterministic request suppression (Copilot's contextual-filter lite):
      // skip positions where a completion is near-certain useless. Strictness
      // comes from the binding's aggressiveness via the server.
      const lineBefore = model.getValueInRange(
        new monaco.Range(position.lineNumber, 1, position.lineNumber, position.column),
      );
      const lineAfter = model.getValueInRange(
        new monaco.Range(
          position.lineNumber, position.column,
          position.lineNumber, model.getLineMaxColumn(position.lineNumber),
        ),
      );

      const startLine = Math.max(1, position.lineNumber - 79);
      const endLine = Math.min(model.getLineCount(), position.lineNumber + 30);
      const prefix = model.getValueInRange(
        new monaco.Range(startLine, 1, position.lineNumber, position.column),
      );
      const suffix = model.getValueInRange(
        new monaco.Range(position.lineNumber, position.column, endLine, model.getLineMaxColumn(endLine)),
      );
      if (prefix.trim().length === 0 && suffix.trim().length === 0) return empty;

      if (!explicit) {
        const verdict = shouldSkipCompletion({
          lineBefore, lineAfter, languageId: model.getLanguageId(),
          prefixTotalTrimmedLen: prefix.trim().length, suppression: serverSuppression,
        });
        if (verdict.skip) {
          notePrefilterSkip(projectId, verdict.rule ?? 'r?');
          return empty;
        }

        if (!(await debounceWait(serverDebounceMs, token))) return empty;
        if (token.isCancellationRequested) return empty;
      }

      useAiCompleteStore.getState().setBusy(true);
      try {
        const res = await apiCall<EditorCompleteResult>('editor.complete', {
          projectId,
          file: relPath,
          language: model.getLanguageId(),
          position: { line: position.lineNumber, col: position.column },
          prefix,
          suffix,
        });
        if (res.debounceMs && res.debounceMs > 0) serverDebounceMs = res.debounceMs;
        if (res.suppression) serverSuppression = res.suppression;

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
        // Feed the forward cache: typing through this text keeps serving the
        // remainder client-side without a new request.
        recordShownCompletion(forwardKey, position.lineNumber, position.column, res.text, res.requestId);
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
              _requestId: res.requestId,
            } as MonacoNs.languages.InlineCompletion,
          ],
          enableForwardStability: true,
        };
      } catch (err) {
        logLsp({ op: 'inline', file: relPath, lang: model.getLanguageId(),
                 outcome: 'threw', err: err instanceof Error ? err.message : String(err) });
        snoozedUntil = Date.now() + 30_000;
        return empty;
      } finally {
        useAiCompleteStore.getState().setBusy(false);
      }
    },
    // ── Lifecycle telemetry (ground-truth accept/reject rates) ────────────
    handleItemDidShow(_completions, item) {
      const requestId = (item as { _requestId?: string })._requestId;
      if (!requestId) return;
      noteShown(projectId, requestId);
      useAiCompleteStore.getState().setSuggestionVisible(true);
    },
    handlePartialAccept(_completions, item, acceptedCharacters, info) {
      const requestId = (item as { _requestId?: string })._requestId;
      if (!requestId) return;
      const kind = info?.kind === monaco.languages.PartialAcceptTriggerKind.Line
        ? 'line'
        : info?.kind === monaco.languages.PartialAcceptTriggerKind.Suggest
          ? 'suggest'
          : 'word';
      notePartial(projectId, requestId, acceptedCharacters, kind);
    },
    freeInlineCompletions(completions) {
      for (const item of completions?.items ?? []) {
        const requestId = (item as { _requestId?: string })._requestId;
        if (requestId) noteFreed(requestId);
      }
      if (!anyTracked()) useAiCompleteStore.getState().setSuggestionVisible(false);
    },
  });
}
