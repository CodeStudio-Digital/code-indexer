import { ACTIVE_RUN_STATUSES, NUDGE_LRU_MAX, COOLDOWN_DECISION_MS, COOLDOWN_RESURRECT_MS, readNudgeMs, parsePersistedTimestamp, decisionKindOf } from './runtime-reconciler-policy.js';
import type { RuntimeReconcilerDeps } from './runtime-reconciler-policy.js';

import { MASTER_INBOX_SENTINEL } from '@mcp/company/services/MasterInboxRouter.js';

import { countReadyTodoCards, evaluateNextCardNudge, readNextCardIdleMs } from '@mcp/company/services/scheduler/next-card-nudge.js';

export class RuntimeDecisionNudger {
  constructor(private readonly deps: RuntimeReconcilerDeps) {}

  /** Per-key last-nudge wall-clock for cooldown dedup. Bounded LRU. */
  private readonly lastNudgeAt = new Map<string, number>();

  /** C3 — wall-clock of the last next-card nudge (its own long cooldown). */
  private lastNextCardNudgeAt = 0;

  private nowMs(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  // ── Master re-nudge (Item 4) ──────────────────────────────────────

  /**
   * Re-wake a stalled master WITHOUT calling the LLM. Runs on its own 15s
   * timer (independent of the 45s reconcile tick). Three cases:
   *   (a) master ALIVE + a subordinate's plan/question/tasks pending longer
   *       than the threshold → re-emit the attention signal. The message is
   *       already in pendingUserMessages, so re-notifying would DUPLICATE it;
   *       we only re-fire the wake signal that `notify` emits.
   *   (b) master ALIVE + a master-bound inbox message stalled → re-run the
   *       idempotent `tryDeliverNow`.
   *   (c) master DEAD + a decision pending but no inbox row to revive it →
   *       `notify` to resurrect so it can read the board and respond.
   *       (Dead + pending inbox is already covered by `heartbeatMasterInbox`.)
   *
   * Dedup: per-key cooldown (`recentlyNudged`) re-nudges a still-stuck item
   * later but never every tick. A decision resolved in the meantime is skipped
   * because the in-memory `hasPending*` cross-check returns false.
   */
  async nudgeStalledMasterDecisions(): Promise<void> {
    const nudgeMs = readNudgeMs();
    if (nudgeMs === 0) return;
    const sessionId = this.deps.ctx.companySessionId;
    const now = this.nowMs();

    const stalled = this.deps.ctx.companyFiles
      .listAgentRunsSync()
      .filter((r) => {
        if (r.role === 'master') return false;
        const kind = decisionKindOf(r.status);
        if (!kind || !this.decisionStillPending(r.id, kind)) return false;
        const ageMs = now - parsePersistedTimestamp(r.updated_at);
        return Number.isFinite(ageMs) && ageMs >= nudgeMs;
      });

    if (this.deps.master.isAlive) {
      for (const r of stalled) {
        const kind = decisionKindOf(r.status)!;
        const key = `a:${r.id}:${kind}`;
        if (this.recentlyNudged(key, now)) continue;
        this.recordNudge(key, now);
        // NO LLM, NO re-push: the original notification is still buffered in
        // pendingUserMessages. Re-emit the wake signal (and defensively break a
        // waitForUserInput, mirroring HumanInTheLoop's original post).
        this.deps.master.handle?.runner.interruptWait({ kind, agentRunId: r.id, role: r.role });
        this.deps.attention.signal({ kind, agentRunId: r.id, role: r.role });
        this.publishNudge({ case: 'decision', agentRunId: r.id, role: r.role, kind, ageMs: now - parsePersistedTimestamp(r.updated_at) });
        console.log(`[company s=${sessionId}] master nudge (decision): re-woke for run=${r.id} kind=${kind}`);
      }
      await this.nudgeStalledInbox(sessionId, now, nudgeMs);
      // C3 — proactive board nudge: idle master + ready todo cards + zero
      // active subordinates → suggest dispatching. Logic lives in the pure
      // scheduler/next-card-nudge.ts module; this is only the shell.
      this.maybeNudgeNextCard(now);
      return;
    }

    // Master dead: revive for a pending decision the inbox heartbeat won't see.
    // Shared dedup: skip if a resurrect already fired recently — the supervisor
    // (or a prior tick) may have revived the master through MasterLifecycle.
    if (
      stalled.length > 0 &&
      !this.recentlyNudged('c:resurrect', now) &&
      !this.deps.master.resurrectedWithinMs(COOLDOWN_RESURRECT_MS)
    ) {
      this.recordNudge('c:resurrect', now);
      this.deps.master.notify(
        '[SYSTEM] A subordinate is blocked awaiting your decision and your run had ended. ' +
        'Resuming so you can review the pending plan/question/tasks on the board and respond.',
      );
      this.publishNudge({ case: 'resurrect', reason: 'decision_pending' });
      console.log(`[company s=${sessionId}] master nudge (resurrect): ${stalled.length} pending decision(s), master dead`);
    }
  }

  /** C3 — shell for the pure next-card nudge (scheduler/next-card-nudge.ts). */
  private maybeNudgeNextCard(now: number): void {
    const kanban = this.deps.kanban;
    if (!kanban) return;
    try {
      const runs = this.deps.ctx.companyFiles.listAgentRunsSync();
      const masterRow = runs.find((r) => r.role === 'master');
      const decision = evaluateNextCardNudge({
        masterAlive: this.deps.master.isAlive,
        masterIdleMs: now - parsePersistedTimestamp(masterRow?.updated_at),
        activeSubordinateCount: runs.filter(
          (r) => r.role !== 'master' && ACTIVE_RUN_STATUSES.has(r.status),
        ).length,
        readyTodoCount: countReadyTodoCards(kanban.listCardsFull()),
        nowMs: now,
        lastNudgeAtMs: this.lastNextCardNudgeAt,
        idleThresholdMs: readNextCardIdleMs(),
      });
      if (!decision.nudge) return;
      this.lastNextCardNudgeAt = now;
      this.deps.master.notify(decision.message);
      this.publishNudge({ case: 'next_card', reason: 'ready_cards', readyCount: decision.readyCount });
      console.log(
        `[company s=${this.deps.ctx.companySessionId}] master nudge (next_card): ${decision.readyCount} ready todo card(s), idle master`,
      );
    } catch { /* nudge must never break the sweep */ }
  }

  private decisionStillPending(id: string, kind: 'plan' | 'question' | 'tasks'): boolean {
    if (kind === 'plan') return this.deps.humanInLoop.hasPendingPlan(id);
    if (kind === 'question') return this.deps.humanInLoop.hasPendingQuestion(id);
    return this.deps.humanInLoop.hasPendingTasks(id);
  }

  private async nudgeStalledInbox(sessionId: string, now: number, nudgeMs: number): Promise<void> {
    const pending = this.deps.ctx.companyFiles.listInboxMessagesSync({
      toRole: MASTER_INBOX_SENTINEL,
      status: 'pending',
    });
    const oldest = pending.find((m) => {
      const created = parsePersistedTimestamp(m.created_at);
      return Number.isFinite(created) && now - created >= nudgeMs;
    });
    if (!oldest || this.recentlyNudged(`b:${oldest.id}`, now)) return;
    this.recordNudge(`b:${oldest.id}`, now);
    await this.deps.masterInbox.tryDeliverNow();
    this.publishNudge({ case: 'inbox', messageId: oldest.id, ageMs: now - parsePersistedTimestamp(oldest.created_at) });
    console.log(`[company s=${sessionId}] master nudge (inbox): re-delivered, oldest msg=${oldest.id}`);
  }

  private recentlyNudged(key: string, now: number): boolean {
    const at = this.lastNudgeAt.get(key);
    if (at === undefined) return false;
    const cooldown = key.startsWith('c:') ? COOLDOWN_RESURRECT_MS : COOLDOWN_DECISION_MS;
    return now - at < cooldown;
  }

  private recordNudge(key: string, now: number): void {
    if (this.lastNudgeAt.size >= NUDGE_LRU_MAX) {
      const first = this.lastNudgeAt.keys().next().value;
      if (first !== undefined) this.lastNudgeAt.delete(first);
    }
    this.lastNudgeAt.set(key, now);
  }

  private publishNudge(payload: {
    case: 'decision' | 'inbox' | 'resurrect' | 'next_card';
    agentRunId?: string;
    role?: string;
    kind?: 'plan' | 'question' | 'tasks';
    messageId?: string;
    reason?: string;
    ageMs?: number;
    /** next_card only — how many ready todo cards triggered the nudge. */
    readyCount?: number;
  }): void {
    try {
      this.deps.publisher.publish('master_nudge', {
        companySessionId: this.deps.ctx.companySessionId,
        ...payload,
        at: this.nowMs(),
      });
    } catch { /* publish must never break the sweep */ }
  }
}
