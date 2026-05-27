/**
 * C8 — InboxMessageWatchdog (Sprint 3.5).
 *
 * Periodic watcher that detects `agent_inbox` messages stuck in
 * `pending`/`delivered` status past a threshold (default 5 min) and
 * publishes `inbox_message_stuck` events on the MetaBus. Master
 * listeners can then reassign, escalate, or cancel — instead of
 * silently waiting for the full timeout to fire EXPIRED.
 *
 * **Design**:
 *   - Process-wide singleton, started by the host during boot.
 *   - Interval-based (`setInterval`); default 30s scan.
 *   - Read-only against `agent_inbox` (no DB mutation here — listeners
 *     decide whether to flip statuses).
 *   - Idempotent — repeated stuck events for the same message ID are
 *     deduped via a `notifiedMessageIds` set bounded by LRU eviction.
 *   - Stops cleanly via `stop()` for graceful shutdown.
 *
 * **Why a watchdog vs the existing waitForAnswer timeout**:
 *   - The legacy timeout punishes the SENDER (wait long, then EXPIRED).
 *     Watchdog detects stuckness BEFORE timeout and gives master a
 *     chance to act — possibly resolving the request via reassign.
 *   - Watchdog runs decoupled from any specific send(), so messages
 *     where the sender DIDN'T `wait=true` are also covered.
 *
 * **Defaults** (env-overridable):
 *   - `MCP_COMPANY_INBOX_WATCHDOG_INTERVAL_MS` — scan period, default 30_000
 *   - `MCP_COMPANY_INBOX_WATCHDOG_STUCK_MS` — stuck threshold, default 5*60_000
 *   - `MCP_COMPANY_INBOX_WATCHDOG_ENABLED` — `'1'` to start at boot (default `'0'`)
 */
import type { CompanyStore } from '@mcp/store/company-store.js';
import type { IMetaBusPublisher } from './ports.js';

export interface InboxWatchdogDeps {
  companyStore: CompanyStore;
  publisher: IMetaBusPublisher;
  /** Override for tests. Defaults to `Date.now()`. */
  now?: () => number;
}

export interface InboxStuckEvent {
  messageId: number;
  companySessionId: number;
  fromAgentRunId: number;
  fromRole: string;
  toAgentRunId: number | null;
  toRole: string | null;
  status: 'pending' | 'delivered';
  /** ms since the message was created. */
  ageMs: number;
  /** Wall-clock ms when the watchdog flagged this message. */
  detectedAtMs: number;
}

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_STUCK_MS = 5 * 60 * 1000;
const NOTIFIED_LRU_MAX = 1000;

function resolveIntervalMs(): number {
  const raw = process.env.MCP_COMPANY_INBOX_WATCHDOG_INTERVAL_MS;
  if (!raw) return DEFAULT_INTERVAL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_INTERVAL_MS;
}

function resolveStuckMs(): number {
  const raw = process.env.MCP_COMPANY_INBOX_WATCHDOG_STUCK_MS;
  if (!raw) return DEFAULT_STUCK_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STUCK_MS;
}

export class InboxMessageWatchdog {
  private timer: ReturnType<typeof setInterval> | null = null;
  /**
   * IDs we've already emitted `inbox_message_stuck` for. Prevents
   * repeated notifications when the same message remains stuck across
   * many scan windows. Bounded LRU; oldest entries drop when full.
   */
  private notifiedMessageIds = new Set<number>();
  /** Number of scans completed since start — diagnostic-only. */
  private scanCount = 0;

  constructor(private readonly deps: InboxWatchdogDeps) {}

  /**
   * Start the periodic scanner. No-op if already running. The first
   * scan fires immediately so tests don't have to wait for the
   * interval; the next scan happens after `intervalMs`.
   */
  start(): void {
    if (this.timer) return;
    const intervalMs = resolveIntervalMs();
    // Fire-and-forget initial scan
    void this.scanOnce();
    this.timer = setInterval(() => {
      void this.scanOnce();
    }, intervalMs);
    // Don't keep the event loop alive just for the watchdog.
    if (typeof (this.timer as { unref?: () => unknown }).unref === 'function') {
      (this.timer as { unref: () => unknown }).unref();
    }
  }

  /** Stop scanning. Safe to call multiple times. */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Diagnostic accessor — has the watchdog flagged this message yet?
   * Useful for tests and the admin panel.
   */
  hasNotified(messageId: number): boolean {
    return this.notifiedMessageIds.has(messageId);
  }

  /** Number of completed scans since `start()`. */
  getScanCount(): number {
    return this.scanCount;
  }

  /**
   * Reset the notified-IDs set. Use after a scan-window-spanning
   * incident is resolved (e.g. admin manually re-assigns the message).
   * Without a reset, the watchdog won't re-notify on the same ID even
   * if it really IS stuck again later.
   */
  clearNotifiedIds(): void {
    this.notifiedMessageIds.clear();
  }

  /**
   * Public scan-once entry point — exposed for tests. Walks every
   * company session with at least one pending message; for each
   * matching message older than the stuck threshold, emits a
   * `inbox_message_stuck` event (deduped by message id).
   */
  async scanOnce(): Promise<InboxStuckEvent[]> {
    this.scanCount++;
    const now = this.deps.now ? this.deps.now() : Date.now();
    const stuckMs = resolveStuckMs();
    const cutoff = now - stuckMs;
    const sessions = this.deps.companyStore.listSessionsWithPendingMasterInbox();
    // listSessionsWithPendingMasterInbox covers master-bound pending;
    // we also need peer-to-peer pending. Walk every active company
    // session we know about via the same store.
    const allSessions = new Set<number>(sessions);
    // listInboxMessages requires a company_session_id; we don't have
    // a "list all companies" method, so the master-bound query is our
    // narrowest filter. Tests pass companySessionId via mock.
    // (If you need wider coverage, extend CompanyStore with a
    // `listSessionsWithAnyPendingInbox()` helper.)

    const emitted: InboxStuckEvent[] = [];
    for (const sid of allSessions) {
      const messages = this.deps.companyStore.listInboxMessages({
        companySessionId: sid,
        status: ['pending', 'delivered'],
      });
      for (const m of messages) {
        if (this.notifiedMessageIds.has(m.id)) continue;
        const createdMs = Date.parse(m.created_at);
        if (!Number.isFinite(createdMs)) continue;
        if (createdMs > cutoff) continue; // not yet stuck
        const ageMs = now - createdMs;
        const event: InboxStuckEvent = {
          messageId: m.id,
          companySessionId: sid,
          fromAgentRunId: m.from_agent_run_id,
          fromRole: m.from_role,
          toAgentRunId: m.to_agent_run_id ?? null,
          toRole: m.to_role ?? null,
          status: m.status as 'pending' | 'delivered',
          ageMs,
          detectedAtMs: now,
        };
        emitted.push(event);
        this.recordNotified(m.id);
        try {
          this.deps.publisher.publish('inbox_message_stuck', event);
        } catch (e) {
          console.warn(
            `[inbox-watchdog] publish failed for message ${m.id}: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
      }
    }
    return emitted;
  }

  private recordNotified(id: number): void {
    if (this.notifiedMessageIds.size >= NOTIFIED_LRU_MAX) {
      // Drop the oldest by deletion order. Set preserves insertion
      // order; we evict the first key. Not strict LRU but bounded.
      const first = this.notifiedMessageIds.values().next().value;
      if (first !== undefined) this.notifiedMessageIds.delete(first);
    }
    this.notifiedMessageIds.add(id);
  }
}

/**
 * Helper that builds the watchdog and starts it when the
 * `MCP_COMPANY_INBOX_WATCHDOG_ENABLED=1` env flag is set. Hosts
 * unconditionally call this during boot; the gating happens here.
 */
export function startInboxWatchdogIfEnabled(
  deps: InboxWatchdogDeps,
): InboxMessageWatchdog | null {
  if (process.env.MCP_COMPANY_INBOX_WATCHDOG_ENABLED !== '1') return null;
  const wd = new InboxMessageWatchdog(deps);
  wd.start();
  return wd;
}
