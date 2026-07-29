/**
 * C1 — maps organism-visibility SSE events into `AutonomyEvent`s for the
 * autonomy slice ring:
 *
 *   scheduler_dispatched  → 'dispatch'
 *   scheduler_skipped     → 'skip'
 *   scheduler_sweep       → 'dispatch' (aggregate; keeps `event` for text)
 *   plan_auto_approved    → 'approval'
 *   supervisor_incident   → 'incident'
 *   master_nudge          → 'nudge'   (already published by RuntimeReconciler)
 *
 * Pure + fully defensive: unknown events return null, malformed payloads
 * degrade to an event with only `type` + `atMs` (the dashboard has no tsc
 * gate, so nothing here may throw on a weird payload).
 */
import type { AutonomyEvent, AutonomyEventType } from '../autonomySlice.js';

let localSeq = 0;

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asRecord(data: unknown): Record<string, unknown> {
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}

function make(
  type: AutonomyEventType,
  eventType: string,
  atMs: number,
  fields: Omit<AutonomyEvent, 'id' | 'atMs' | 'type' | 'event'>,
): AutonomyEvent {
  return { id: `${eventType}:${atMs}:${localSeq++}`, atMs, type, event: eventType, ...fields };
}

/**
 * Returns the mapped event, or null when `eventType` is not an
 * autonomy-visibility event (caller falls through to other handlers).
 */
export function mapAutonomyStreamEvent(eventType: string, data: unknown): AutonomyEvent | null {
  const d = asRecord(data);
  const atMs = num(d.at) ?? num(d.detectedAtMs) ?? Date.now();
  switch (eventType) {
    case 'scheduler_dispatched':
      return make('dispatch', eventType, atMs, {
        cardId: str(d.cardId),
        role: str(d.role),
        agentRunId: str(d.agentRunId),
      });
    case 'scheduler_skipped':
      return make('skip', eventType, atMs, {
        cardId: str(d.cardId),
        reason: str(d.reason),
      });
    case 'scheduler_sweep':
      return make('dispatch', eventType, atMs, {
        dispatched: num(d.dispatched),
        freeSlots: num(d.freeSlots),
      });
    case 'plan_auto_approved':
      return make('approval', eventType, atMs, {
        agentRunId: str(d.agentRunId),
        role: str(d.role),
      });
    case 'supervisor_incident':
      return make('incident', eventType, atMs, {
        kind: str(d.kind),
        agentRunId: str(d.agentRunId),
        role: str(d.role),
        detail: str(d.detail),
      });
    case 'master_nudge':
      return make('nudge', eventType, atMs, {
        kind: str(d.case),
        agentRunId: str(d.agentRunId),
        role: str(d.role),
        reason: str(d.reason),
      });
    default:
      return null;
  }
}
