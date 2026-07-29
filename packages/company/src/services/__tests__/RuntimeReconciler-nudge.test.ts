/**
 * Tests for the RuntimeReconciler master re-nudge sweep (Item 4).
 *
 * Locks in:
 *   - (a) live master + stalled decision → attention.signal re-emitted with the
 *         decision kind; notify() NOT called (the message is already buffered,
 *         re-notifying would duplicate it); interruptWait fired defensively.
 *   - dedup cooldown: a second sweep inside the window does not re-signal.
 *   - in-memory cross-check: DB says waiting but HitL no longer pending → skip.
 *   - not-yet-stalled: age below the threshold → no nudge.
 *   - (b) live master + stalled master-bound inbox → tryDeliverNow.
 *   - (c) dead master + pending decision → notify() to resurrect.
 *   - knob = 0 disables the sweep entirely.
 *   - timestamps in SQLite `datetime('now')` shape (UTC, no zone marker) are
 *     parsed as UTC — guards the timezone-skew trap in parseSqliteUtc.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeReconciler, type RuntimeReconcilerDeps } from '../RuntimeReconciler.js';

type Run = { id: string; role: string; status: string; updated_at: string | null };
type Msg = { id: string; created_at: string; status: string; to_role: string };
const runId = (n: number): string =>
  `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const messageId = (n: number): string =>
  `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Render a wall-clock `ms`-ago timestamp in SQLite `datetime('now')` shape:
 *  "YYYY-MM-DD HH:MM:SS", UTC, NO zone marker. Exercises parseSqliteUtc's
 *  normalization — a naive Date.parse would read this as local time. */
function sqliteAgo(now: number, ms: number): string {
  return new Date(now - ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

interface Spies {
  signal: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  tryDeliverNow: ReturnType<typeof vi.fn>;
  interruptWait: ReturnType<typeof vi.fn>;
  published: Array<{ topic: string; payload: Record<string, unknown> }>;
}

function makeReconciler(opts: {
  now: number;
  alive: boolean;
  runs: Run[];
  messages?: Msg[];
  pending?: { plan?: Set<string>; question?: Set<string>; tasks?: Set<string> };
}): { spies: Spies; nudge: () => Promise<void> } {
  const spies: Spies = {
    signal: vi.fn(),
    notify: vi.fn(),
    tryDeliverNow: vi.fn(async () => {}),
    interruptWait: vi.fn(),
    published: [],
  };
  const pending = opts.pending ?? {};
  const deps = {
    ctx: {
      companySessionId: 'c0000000-0000-4000-8000-000000000001',
      companyFiles: {
        listAgentRunsSync: () => opts.runs,
        listInboxMessagesSync: () => opts.messages ?? [],
      },
    },
    master: {
      get isAlive() { return opts.alive; },
      handle: opts.alive ? { runner: { interruptWait: spies.interruptWait } } : null,
      notify: spies.notify,
      // Dedup guard the reconciler consults before resurrecting — a dead
      // master in these tests was never recently resurrected.
      resurrectedWithinMs: () => false,
    },
    subordinates: {},
    masterInbox: { tryDeliverNow: spies.tryDeliverNow },
    publisher: {
      publish: (topic: string, payload: Record<string, unknown>) => {
        spies.published.push({ topic, payload });
      },
      bus: undefined,
      markEnded() {},
    },
    humanInLoop: {
      hasPendingPlan: (id: string) => pending.plan?.has(id) ?? false,
      hasPendingQuestion: (id: string) => pending.question?.has(id) ?? false,
      hasPendingTasks: (id: string) => pending.tasks?.has(id) ?? false,
    },
    attention: { signal: spies.signal },
    now: () => opts.now,
  } as unknown as RuntimeReconcilerDeps;
  const reconciler = new RuntimeReconciler(deps);
  const nudge = () =>
    (reconciler as unknown as { nudgeStalledMasterDecisions: () => Promise<void> })
      .nudgeStalledMasterDecisions();
  return { spies, nudge };
}

const NOW = 1_700_000_000_000;

describe('RuntimeReconciler — master re-nudge', () => {
  const original = process.env.MCP_COMPANY_MASTER_NUDGE_MS;
  beforeEach(() => { delete process.env.MCP_COMPANY_MASTER_NUDGE_MS; }); // default 30s
  afterEach(() => {
    if (original === undefined) delete process.env.MCP_COMPANY_MASTER_NUDGE_MS;
    else process.env.MCP_COMPANY_MASTER_NUDGE_MS = original;
  });

  it('(a) re-signals a live master for a stalled plan WITHOUT re-notifying', async () => {
    const { spies, nudge } = makeReconciler({
      now: NOW,
      alive: true,
      runs: [{ id: runId(42), role: 'backend', status: 'waiting_plan', updated_at: sqliteAgo(NOW, 31_000) }],
      pending: { plan: new Set([runId(42)]) },
    });
    await nudge();
    expect(spies.signal).toHaveBeenCalledTimes(1);
    expect(spies.signal).toHaveBeenCalledWith({ kind: 'plan', agentRunId: runId(42), role: 'backend' });
    expect(spies.interruptWait).toHaveBeenCalledWith({ kind: 'plan', agentRunId: runId(42), role: 'backend' });
    // Must NOT re-push the message — it's already in pendingUserMessages.
    expect(spies.notify).not.toHaveBeenCalled();
    expect(spies.published.map((p) => p.topic)).toContain('master_nudge');
  });

  it('dedup: a second sweep inside the cooldown does not re-signal', async () => {
    const { spies, nudge } = makeReconciler({
      now: NOW,
      alive: true,
      runs: [{ id: runId(42), role: 'backend', status: 'waiting_question', updated_at: sqliteAgo(NOW, 60_000) }],
      pending: { question: new Set([runId(42)]) },
    });
    await nudge();
    await nudge();
    expect(spies.signal).toHaveBeenCalledTimes(1);
  });

  it('cross-check: DB waiting but HitL no longer pending → no nudge', async () => {
    const { spies, nudge } = makeReconciler({
      now: NOW,
      alive: true,
      runs: [{ id: runId(7), role: 'qa', status: 'waiting_plan', updated_at: sqliteAgo(NOW, 120_000) }],
      pending: { plan: new Set() }, // resolved already
    });
    await nudge();
    expect(spies.signal).not.toHaveBeenCalled();
  });

  it('not-yet-stalled (age < threshold) → no nudge', async () => {
    const { spies, nudge } = makeReconciler({
      now: NOW,
      alive: true,
      runs: [{ id: runId(9), role: 'backend', status: 'waiting_tasks', updated_at: sqliteAgo(NOW, 5_000) }],
      pending: { tasks: new Set([runId(9)]) },
    });
    await nudge();
    expect(spies.signal).not.toHaveBeenCalled();
  });

  it('(b) re-delivers a stalled master-bound inbox message on a live master', async () => {
    const { spies, nudge } = makeReconciler({
      now: NOW,
      alive: true,
      runs: [],
      messages: [{ id: messageId(5), created_at: sqliteAgo(NOW, 45_000), status: 'pending', to_role: '__master__' }],
    });
    await nudge();
    expect(spies.tryDeliverNow).toHaveBeenCalledTimes(1);
  });

  it('(c) resurrects a dead master that has a pending decision', async () => {
    const { spies, nudge } = makeReconciler({
      now: NOW,
      alive: false,
      runs: [{ id: runId(3), role: 'frontend', status: 'waiting_plan', updated_at: sqliteAgo(NOW, 90_000) }],
      pending: { plan: new Set([runId(3)]) },
    });
    await nudge();
    expect(spies.notify).toHaveBeenCalledTimes(1);
    expect(spies.signal).not.toHaveBeenCalled(); // dead → no live-signal path
  });

  it('knob = 0 disables the sweep', async () => {
    process.env.MCP_COMPANY_MASTER_NUDGE_MS = '0';
    const { spies, nudge } = makeReconciler({
      now: NOW,
      alive: true,
      runs: [{ id: runId(42), role: 'backend', status: 'waiting_plan', updated_at: sqliteAgo(NOW, 120_000) }],
      pending: { plan: new Set([runId(42)]) },
    });
    await nudge();
    expect(spies.signal).not.toHaveBeenCalled();
    expect(spies.notify).not.toHaveBeenCalled();
    expect(spies.tryDeliverNow).not.toHaveBeenCalled();
  });
});
