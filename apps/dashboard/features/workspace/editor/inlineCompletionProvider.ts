/**
 * AI ghost-text — Monaco inline completions backed by `editor.complete`
 * (pipeline binding editor/autocomplete, admin-configured).
 *
 * Cost guardrails, in gate order: feature toggle (localStorage, default
 * OFF) → per-project/route cooldown → suggest-widget-open skip → debounce
 * (server-suggested, default 300ms). Cancellation is exact by clientRequestId;
 * compatible prefix advances coalesce server-side instead of restarting.
 */
import type * as MonacoNs from 'monaco-editor';
import { apiCall } from '../../../lib/api-client.js';
import type { EditorCompleteResult, EditorDeliveryDiscardReason } from '@mcp/api-bus';
import { shouldSkipCompletion, type Suppression } from '@mcp/shared/editor/completion-prefilter.js';
import { logLsp } from './lsp-log.js';
import { parseModelPath } from './editor-models-path.js';
import { recordShownCompletion, tryForwardCompletion } from './completionForwardCache.js';
import { consumeForceProvide } from './ai-complete-commands.js';
import { noteShown, notePartial, noteAccept, noteFreed, anyTracked } from './aiCompleteFeedback.js';
import { getActiveEditor } from './editor-models.js';
import {
  adaptCompletionText,
  ClientCompletionFlightCoordinator,
  compatibleCompletionSnapshot,
  type ClientCompletionSnapshot,
} from './completionFlightCoordinator.js';
import {
  registerAiCompleteToggleEffect,
  useAiCompleteStore,
} from './ai-complete-store.js';

export {
  aiCompleteToggleUnset,
  useAiCompleteStore,
  type AiCompleteIssue,
  type AiCompleteNudge,
} from './ai-complete-store.js';

type Monaco = typeof MonacoNs;

const UNCONFIGURED_SNOOZE_MS = 5 * 60_000;
const TIMEOUT_SNOOZE_MS = 15_000;
const PREFILTER_REPORT_MS = 60_000;
const CLIENT_RESULT_TTL_MS = 1_000;

const cooldowns = new Map<string, number>();
const activeRoute = new Map<number, string>();
let serverDebounceMs = 300;
let serverSuppression: Suppression = 'standard';
let acceptCommandRegistered = false;
const clientFlights = new ClientCompletionFlightCoordinator<EditorCompleteResult>();
const retriggeredFlights = new Set<string>();
let automaticRetrigger: { uri: string; until: number } | null = null;
let busyWaiters = 0;

registerAiCompleteToggleEffect((enabled) => {
  // Re-enabling resets the snooze so the user gets immediate feedback.
  if (enabled) cooldowns.clear();
  clientFlights.clear();
});

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

function noteDelivery(
  projectId: number,
  input: {
    clientRequestId: string; requestId?: string; stage: 'received' | 'returned' | 'discarded';
    reason?: EditorDeliveryDiscardReason; documentVersion?: number;
  },
): void {
  void apiCall('editor.delivery', { projectId, ...input }).catch(() => undefined);
}

function setFlightBusy(active: boolean): void {
  busyWaiters = Math.max(0, busyWaiters + (active ? 1 : -1));
  useAiCompleteStore.getState().setBusy(busyWaiters > 0);
}

function snapshotAt(
  monaco: Monaco,
  model: MonacoNs.editor.ITextModel,
  position: MonacoNs.Position,
  trigger: 'automatic' | 'explicit',
): ClientCompletionSnapshot {
  const startLine = Math.max(1, position.lineNumber - 79);
  const endLine = Math.min(model.getLineCount(), position.lineNumber + 30);
  return {
    uri: model.uri.toString(),
    prefix: model.getValueInRange(new monaco.Range(startLine, 1, position.lineNumber, position.column)),
    suffix: model.getValueInRange(new monaco.Range(
      position.lineNumber, position.column, endLine, model.getLineMaxColumn(endLine),
    )),
    line: position.lineNumber,
    col: position.column,
    documentVersion: model.getVersionId(),
    trigger,
  };
}

function triggerAutomaticSuggestion(uri: string, clientRequestId: string): void {
  if (retriggeredFlights.has(clientRequestId)) return;
  const editor = getActiveEditor();
  const model = editor?.getModel();
  if (!editor || !model || model.uri.toString() !== uri) return;
  retriggeredFlights.add(clientRequestId);
  setTimeout(() => retriggeredFlights.delete(clientRequestId), CLIENT_RESULT_TTL_MS);
  automaticRetrigger = { uri, until: Date.now() + CLIENT_RESULT_TTL_MS };
  queueMicrotask(() => editor.trigger('ai-completion', 'editor.action.inlineSuggest.trigger', null));
}

function maybeRetriggerResolved(
  monaco: Monaco,
  key: string,
  clientRequestId: string,
  anchor: ClientCompletionSnapshot,
  result: EditorCompleteResult,
): void {
  if (result.status !== 'ok' || !result.text || clientFlights.hasWaiters(key)) return;
  const editor = getActiveEditor();
  const model = editor?.getModel();
  const position = editor?.getPosition();
  if (!editor || !model || !position || model.uri.toString() !== anchor.uri) return;
  const current = snapshotAt(monaco, model, position, anchor.trigger);
  const match = compatibleCompletionSnapshot(anchor, current);
  if (!match.compatible || !('text' in adaptCompletionText(result.text, match.typedThrough))) return;
  triggerAutomaticSuggestion(anchor.uri, clientRequestId);
}

export function resetClientCompletionFlights(): void {
  clientFlights.clear();
  automaticRetrigger = null;
  retriggeredFlights.clear();
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
      const isAutomaticRetrigger = automaticRetrigger?.uri === model.uri.toString()
        && Date.now() <= automaticRetrigger.until;
      if (isAutomaticRetrigger) automaticRetrigger = null;
      const forced = consumeForceProvide();
      const explicit = !isAutomaticRetrigger
        && (forced || context.triggerKind === monaco.languages.InlineCompletionTriggerKind.Explicit);
      if (!store.enabled) return empty;
      if (explicit) {
        for (const key of cooldowns.keys()) if (key.startsWith(`${projectId}:`)) cooldowns.delete(key);
      } else if (!isAutomaticRetrigger) {
        const routeKey = activeRoute.get(projectId) ?? 'unconfigured';
        if (Date.now() < (cooldowns.get(`${projectId}:${routeKey}`) ?? 0)) return empty;
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

      const snapshot = snapshotAt(monaco, model, position, explicit ? 'explicit' : 'automatic');
      const { prefix, suffix } = snapshot;
      if (prefix.trim().length === 0 && suffix.trim().length === 0) return empty;

      if (!explicit && !isAutomaticRetrigger) {
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

      setFlightBusy(true);
      const flightKey = `${projectId}:${snapshot.uri}`;
      const lease = clientFlights.acquire({
        key: flightKey,
        snapshot,
        cancelDelayMs: Math.max(350, serverDebounceMs + 200),
        cacheTtlMs: CLIENT_RESULT_TTL_MS,
        start: (clientRequestId) => apiCall<EditorCompleteResult>('editor.complete', {
          projectId,
          file: relPath,
          language: model.getLanguageId(),
          position: { line: snapshot.line, col: snapshot.col },
          prefix: snapshot.prefix,
          suffix: snapshot.suffix,
          trigger: snapshot.trigger,
          clientRequestId,
          documentVersion: snapshot.documentVersion,
        }),
        cancel: (clientRequestId) => {
          void apiCall('editor.cancel', { projectId, clientRequestId }).catch(() => undefined);
        },
        onOrphaned: (result, flight) => {
          maybeRetriggerResolved(monaco, flight.key, flight.clientRequestId, flight.anchor, result);
        },
      });
      const cancelDisposable = token.onCancellationRequested(() => {
        lease.release(true);
      });
      try {
        const res = await lease.promise;
        if (res.route) activeRoute.set(projectId, `${res.route.bindingId ?? 'fallback'}:${res.route.providerId}:${res.route.model}`);
        if (res.debounceMs && res.debounceMs > 0) serverDebounceMs = res.debounceMs;
        if (res.suppression) serverSuppression = res.suppression;

        if (res.status === 'unconfigured') {
          cooldowns.set(`${projectId}:unconfigured`, Date.now() + UNCONFIGURED_SNOOZE_MS);
          useAiCompleteStore.getState().setIssue({ kind: 'unconfigured' });
          return empty;
        }
        if (res.status === 'manual_only') {
          const routeKey = activeRoute.get(projectId) ?? 'unknown';
          cooldowns.set(`${projectId}:${routeKey}`, Date.now() + 30_000);
          useAiCompleteStore.getState().setIssue({ kind: 'manual_only', message: res.message });
          return empty;
        }
        if (res.status === 'timeout') {
          const routeKey = activeRoute.get(projectId) ?? 'unknown';
          cooldowns.set(`${projectId}:${routeKey}`, Date.now() + TIMEOUT_SNOOZE_MS);
          useAiCompleteStore.getState().setIssue({ kind: 'timeout', message: res.message });
          return empty;
        }
        if (res.status === 'provider_error') {
          const routeKey = activeRoute.get(projectId) ?? 'unknown';
          cooldowns.set(`${projectId}:${routeKey}`, Date.now() + (res.retryAfterMs ?? 60_000));
          useAiCompleteStore.getState().setIssue({ kind: 'provider_error', message: res.message });
          return empty;
        }
        if (res.status !== 'ok' || !res.text) return empty;
        if (lease.owner) {
          noteDelivery(projectId, {
            clientRequestId: lease.clientRequestId, requestId: res.requestId,
            stage: 'received', documentVersion: snapshot.documentVersion,
          });
        }
        if (token.isCancellationRequested || model.getVersionId() !== snapshot.documentVersion) {
          const reason: EditorDeliveryDiscardReason = model.getVersionId() !== snapshot.documentVersion
            ? 'version_changed' : 'cancelled';
          noteDelivery(projectId, {
            clientRequestId: lease.clientRequestId, requestId: res.requestId,
            stage: 'discarded', reason, documentVersion: snapshot.documentVersion,
          });
          maybeRetriggerResolved(monaco, flightKey, lease.clientRequestId, snapshot, res);
          return empty;
        }

        const adapted = adaptCompletionText(res.text, lease.typedThrough);
        if (!('text' in adapted)) {
          noteDelivery(projectId, {
            clientRequestId: lease.clientRequestId, requestId: res.requestId,
            stage: 'discarded', reason: adapted.reason, documentVersion: snapshot.documentVersion,
          });
          if (adapted.reason === 'prefix_diverged') {
            clientFlights.invalidate(flightKey);
            triggerAutomaticSuggestion(snapshot.uri, lease.clientRequestId);
          }
          return empty;
        }

        useAiCompleteStore.getState().setIssue(null);
        // Feed the forward cache: typing through this text keeps serving the
        // remainder client-side without a new request.
        recordShownCompletion(forwardKey, position.lineNumber, position.column, adapted.text, res.requestId);
        noteDelivery(projectId, {
          clientRequestId: lease.clientRequestId, requestId: res.requestId,
          stage: 'returned', documentVersion: snapshot.documentVersion,
        });
        return {
          items: [
            {
              insertText: adapted.text,
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
        const routeKey = activeRoute.get(projectId) ?? 'unknown';
        cooldowns.set(`${projectId}:${routeKey}`, Date.now() + 30_000);
        return empty;
      } finally {
        lease.release(false);
        cancelDisposable.dispose();
        setFlightBusy(false);
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
