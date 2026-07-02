/**
 * Ground-truth completion lifecycle telemetry. Monaco callbacks feed a
 * module-level tracker; each (requestId, action) reaches the server at most
 * once. A reject only counts when the ghost text was visible ≥250ms
 * (Continue's DO_NOT_COUNT_REJECTED_BEFORE — sub-250ms frees are typing
 * churn, not user judgment). accept-rate truth = accepted / shown.
 */
import { apiCall } from '../../../lib/api-client.js';

export const DO_NOT_COUNT_REJECTED_BEFORE_MS = 250;

interface Tracked {
  projectId: number;
  shownAt: number;
  accepted: boolean;
  partialChars: number;
  partialKind?: 'word' | 'line' | 'suggest';
}

// requestId → lifecycle state; FIFO cap keeps this bounded.
const tracked = new Map<string, Tracked>();
const sentShown = new Set<string>();
const MAX_TRACKED = 256;

function send(projectId: number, body: Record<string, unknown>): void {
  void apiCall('editor.feedback', { projectId, ...body }).catch(() => undefined);
}

function capMaps(): void {
  if (tracked.size > MAX_TRACKED) {
    const oldest = tracked.keys().next().value;
    if (oldest !== undefined) tracked.delete(oldest);
  }
  if (sentShown.size > MAX_TRACKED) {
    const oldest = sentShown.keys().next().value;
    if (oldest !== undefined) sentShown.delete(oldest);
  }
}

/** Monaco handleItemDidShow — dedupe: cache hits re-show the same requestId. */
export function noteShown(projectId: number, requestId: string): void {
  if (!tracked.has(requestId)) {
    tracked.set(requestId, { projectId, shownAt: Date.now(), accepted: false, partialChars: 0 });
    capMaps();
  }
  if (sentShown.has(requestId)) return;
  sentShown.add(requestId);
  send(projectId, { requestId, action: 'shown' });
}

/** Monaco handlePartialAccept — acceptedCharacters is CUMULATIVE. */
export function notePartial(
  projectId: number, requestId: string, acceptedChars: number, kind: 'word' | 'line' | 'suggest',
): void {
  const t = tracked.get(requestId);
  if (!t) return;
  t.partialChars = Math.max(t.partialChars, acceptedChars);
  t.partialKind = kind;
}

/** The accept command ran (full commit). */
export function noteAccept(projectId: number, requestId: string): void {
  const t = tracked.get(requestId);
  if (t) t.accepted = true;
  send(projectId, { requestId, action: 'accept' });
}

/**
 * freeInlineCompletions — the batch is gone. Decide what the user did:
 * full accept already reported → nothing; partial chars taken → 'partial';
 * visible ≥250ms → 'reject'; else drop (typing churn).
 */
export function noteFreed(requestId: string): void {
  const t = tracked.get(requestId);
  if (!t) return; // never shown (superseded pre-render) — no judgment made
  tracked.delete(requestId);
  if (t.accepted) return;
  if (t.partialChars > 0) {
    send(t.projectId, {
      requestId, action: 'partial', acceptedChars: t.partialChars,
      ...(t.partialKind ? { partialKind: t.partialKind } : {}),
    });
    return;
  }
  const shownForMs = Date.now() - t.shownAt;
  if (shownForMs >= DO_NOT_COUNT_REJECTED_BEFORE_MS) {
    send(t.projectId, { requestId, action: 'reject', shownForMs });
  }
}

/** Whether any tracked ghost text is currently live (chip affordance). */
export function anyTracked(): boolean {
  return tracked.size > 0;
}

/** Test hook. */
export function __resetAiFeedbackForTests(): void {
  tracked.clear();
  sentShown.clear();
}
