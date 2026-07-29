/**
 * Per-session notification center store. Holds every notice surfaced during a
 * run — loop/failure interventions, run errors and run completion — so the
 * chat can show a dismissable banner for the ACTIVE
 * ones and a rail panel with the full HISTORY.
 *
 * Mirrors the canonical session-keyed module store of
 * `features/chat/composer/composer-draft-store.ts` (Map + listener Set +
 * notify + `useSyncExternalStore`). In-memory only: notifications are
 * run-scoped diagnostics — they don't survive a reload, same as the
 * `SessionState.toolLoopInterventions` array they replace.
 *
 * Keyed by `coder:<sessionId>` so the coder space never collides
 * with the company-session space if this is ever reused there.
 */
import { useSyncExternalStore } from 'react';
import type { ToolLoopIntervention } from '../../../hooks/agent-stream/types.js';

/** Discriminated payload — one variant per event family that can notify. */
export type SessionNotificationPayload =
  | { kind: 'tool-loop'; intervention: ToolLoopIntervention }
  | { kind: 'run-error'; message: string }
  | { kind: 'run-done'; reason: string; error?: string }
  | {
      kind: 'background-agents-done';
      jobId: string;
      groupId: string;
      agentCount: number;
      successCount: number;
      completedCount: number;
      partialCount: number;
      failedCount: number;
      resumableCount: number;
    };

export type NotificationSeverity = 'info' | 'warning' | 'error';

export interface SessionNotification {
  /** Monotonic id (string for stable React keys). */
  id: string;
  /** `Date.now()` capture time. */
  receivedAt: number;
  severity: NotificationSeverity;
  /** ms until auto-dismiss from the banner; `null` = stays until closed. */
  autoDismissMs: number | null;
  /** Removed from the active banner strip (still kept in history). */
  dismissed: boolean;
  /** Cleared when the panel is opened — drives the rail unread badge. */
  read: boolean;
  /** Stable producer key used to suppress reconnect/StrictMode replay. */
  sourceKey?: string;
  payload: SessionNotificationPayload;
}

export interface PushNotificationOptions {
  sourceKey?: string;
  receivedAt?: number;
}

/** Auto-dismiss budgets by severity. Higher severity lingers longer; the most
 *  severe (error / aborted / run-error) never auto-dismisses. */
const INFO_DISMISS_MS = 10_000;
const WARN_DISMISS_MS = 20_000;

/** History cap per session — generous; oldest dropped past this. */
const HISTORY_CAP = 100;

const byKey = new Map<string, SessionNotification[]>();
const listeners = new Map<string, Set<() => void>>();
let counter = 0;

const EMPTY: readonly SessionNotification[] = Object.freeze([]);

function keyFor(sessionId: string): string {
  return `coder:${sessionId}`;
}

function notify(key: string): void {
  listeners.get(key)?.forEach((cb) => cb());
}

/** Derive severity + auto-dismiss budget from a payload. */
function derive(payload: SessionNotificationPayload): {
  severity: NotificationSeverity;
  autoDismissMs: number | null;
} {
  switch (payload.kind) {
    case 'tool-loop':
      return deriveLoop(payload.intervention.severity);
    case 'run-error':
      return { severity: 'error', autoDismissMs: null };
    case 'run-done':
      return payload.error
        ? { severity: 'error', autoDismissMs: null }
        : { severity: 'info', autoDismissMs: INFO_DISMISS_MS };
    case 'background-agents-done':
      return payload.partialCount > 0 || payload.failedCount > 0
        ? { severity: 'warning', autoDismissMs: WARN_DISMISS_MS }
        : { severity: 'info', autoDismissMs: INFO_DISMISS_MS };
  }
}

function deriveLoop(severity: ToolLoopIntervention['severity']): {
  severity: NotificationSeverity;
  autoDismissMs: number | null;
} {
  switch (severity) {
    case 'aborted':
      return { severity: 'error', autoDismissMs: null };
    case 'informational':
      return { severity: 'info', autoDismissMs: INFO_DISMISS_MS };
    // 'refused'
    default:
      return { severity: 'warning', autoDismissMs: WARN_DISMISS_MS };
  }
}

// ── Public API ──────────────────────────────────────────────────────

/** Append a notification (newest LAST). Returns the created entry's id. */
export function pushNotification(
  sessionId: string,
  payload: SessionNotificationPayload,
  options: PushNotificationOptions = {},
): string {
  const key = keyFor(sessionId);
  const cur = byKey.get(key) ?? [];
  if (options.sourceKey) {
    const duplicate = cur.find((entry) => entry.sourceKey === options.sourceKey);
    if (duplicate) return duplicate.id;
  }
  const { severity, autoDismissMs } = derive(payload);
  const entry: SessionNotification = {
    id: String((counter += 1)),
    receivedAt: options.receivedAt ?? Date.now(),
    severity,
    autoDismissMs,
    dismissed: false,
    read: false,
    ...(options.sourceKey ? { sourceKey: options.sourceKey } : {}),
    payload,
  };
  const next = [...cur, entry];
  byKey.set(key, next.length > HISTORY_CAP ? next.slice(-HISTORY_CAP) : next);
  notify(key);
  return entry.id;
}

/** Mark one notification dismissed (leaves it in history). */
export function dismissNotification(sessionId: string, id: string): void {
  const key = keyFor(sessionId);
  const cur = byKey.get(key);
  if (!cur) return;
  let changed = false;
  const next = cur.map((n) => {
    if (n.id === id && !n.dismissed) {
      changed = true;
      return { ...n, dismissed: true };
    }
    return n;
  });
  if (!changed) return;
  byKey.set(key, next);
  notify(key);
}

/** Dismiss every still-active notification (banner → empty). */
export function dismissAllActive(sessionId: string): void {
  const key = keyFor(sessionId);
  const cur = byKey.get(key);
  if (!cur || cur.every((n) => n.dismissed)) return;
  byKey.set(key, cur.map((n) => (n.dismissed ? n : { ...n, dismissed: true })));
  notify(key);
}

/** Clear the unread badge — call when the panel opens. */
export function markAllRead(sessionId: string): void {
  const key = keyFor(sessionId);
  const cur = byKey.get(key);
  if (!cur || cur.every((n) => n.read)) return;
  byKey.set(key, cur.map((n) => (n.read ? n : { ...n, read: true })));
  notify(key);
}

/** Drop the whole history for a session. */
export function clearNotifications(sessionId: string): void {
  const key = keyFor(sessionId);
  if (!byKey.has(key) || byKey.get(key)!.length === 0) return;
  byKey.set(key, []);
  notify(key);
}

export function getNotifications(sessionId: string): readonly SessionNotification[] {
  return byKey.get(keyFor(sessionId)) ?? EMPTY;
}

export function getActiveNotifications(
  sessionId: string,
): readonly SessionNotification[] {
  return getNotifications(sessionId).filter((n) => !n.dismissed);
}

export function getUnreadCount(sessionId: string): number {
  let n = 0;
  for (const item of getNotifications(sessionId)) if (!item.read) n += 1;
  return n;
}

export function subscribeNotifications(
  sessionId: string,
  cb: () => void,
): () => void {
  const key = keyFor(sessionId);
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(cb);
  return () => {
    set!.delete(cb);
  };
}

// ── React hooks ─────────────────────────────────────────────────────

/**
 * Full notification history (newest last), stable reference between renders.
 * Filter `.dismissed` in the component for the active banner strip — keeping
 * the snapshot identity-stable is required by `useSyncExternalStore`.
 */
export function useSessionNotifications(
  sessionId: string,
): readonly SessionNotification[] {
  return useSyncExternalStore(
    (cb) => subscribeNotifications(sessionId, cb),
    () => getNotifications(sessionId),
    () => EMPTY,
  );
}

/** Unread count for the rail badge. */
export function useUnreadNotificationCount(sessionId: string | null): number {
  return useSyncExternalStore(
    (cb) => sessionId == null ? () => undefined : subscribeNotifications(sessionId, cb),
    () => sessionId == null ? 0 : getUnreadCount(sessionId),
    () => 0,
  );
}
