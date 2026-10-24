import type { SessionContext } from '@mcp/company/services/SessionContext.js';
import type { MasterLifecycle } from '@mcp/company/services/MasterLifecycle.js';
import type { SubordinateLifecycle } from '@mcp/company/services/SubordinateLifecycle.js';
import type { MasterInboxRouter } from '@mcp/company/services/MasterInboxRouter.js';
import type { HumanInTheLoop } from '@mcp/company/services/HumanInTheLoop.js';
import type { MasterAttention } from '@mcp/company/services/MasterAttention.js';
import type { IMetaBusPublisher } from '@mcp/company/services/ports.js';
import type { KanbanService } from '@mcp/company/services/KanbanService.js';
import type { AutonomyProvider } from '@mcp/company/services/autonomy/autonomy-provider.js';
export const DEFAULT_INTERVAL_MS = 45_000;

/** Max auto-reestablish attempts per subordinate before the reconciler gives up
 *  and leaves it 'error' — stops a crash-loop from resuming forever. */
export const REESTABLISH_MAX_ATTEMPTS = 3;

/** Auto re-establish a subordinate that was `running` when its runtime vanished
 *  (worker crash, uncaught throw, OOM) — flip the status so the UI stops showing
 *  "running", then resume it from its persisted coder session so it finishes the
 *  task. ON by default; `MCP_COMPANY_AUTO_REESTABLISH=0` falls back to the old
 *  flip-to-idle behaviour. */
export function autoReestablishEnabled(): boolean {
  const raw = process.env.MCP_COMPANY_AUTO_REESTABLISH;
  if (raw == null || raw === '') return true;
  const v = raw.toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off');
}

/** Agent-run statuses that count as "still doing useful work". Anything else
 *  (idle/completed/error/aborted/interrupted/paused) is dead for the purpose
 *  of the orphaned-card sweep. */
export const ACTIVE_RUN_STATUSES = new Set<string>([
  'running', 'working',
  'waiting', 'waiting_plan', 'waiting_question', 'waiting_tasks',
  'reviewing', 'blocked',
]);

export function readInterval(): number {
  const raw = process.env.MCP_COMPANY_RECONCILE_MS;
  if (!raw) return DEFAULT_INTERVAL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 1_000 ? n : DEFAULT_INTERVAL_MS;
}

// ── Master re-nudge (Item 4) — bridge the gap between a lost wake-up and the
//    30-min MCP_SUBORDINATE_MASTER_WAIT_MS hard fallback, WITHOUT the LLM. ──

/** Re-nudge cadence — its own timer, independent of the 45s reconcile tick,
 *  so a 30s stall is detected with ≤15s latency instead of up to 45s. */
export const NUDGE_TICK_MS = 15_000;

export const DEFAULT_NUDGE_MS = 30_000;

export const NUDGE_LRU_MAX = 1_000;

/** Per-key cooldowns so we re-nudge a still-stuck item again later, but never
 *  every tick. Resurrect is costly → longer cooldown. */
export const COOLDOWN_DECISION_MS = 30_000;

/** Resurrect dedup window — shared with the AgentSupervisor (company-worker
 *  imports this so both watchers use the SAME window, no magic-number drift). */
export const COOLDOWN_RESURRECT_MS = 90_000;

/** 0 = disabled. Non-numeric / negative → default; 1..999 → floored at 1s to
 *  avoid a hot re-nudge loop. */
export function readNudgeMs(): number {
  const raw = process.env.MCP_COMPANY_MASTER_NUDGE_MS;
  if (raw === undefined || raw === '') return DEFAULT_NUDGE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_NUDGE_MS;
  if (n === 0) return 0;
  return n >= 1_000 ? n : 1_000;
}

/**
 * Parse a persisted timestamp to epoch ms. Migration can preserve legacy
 * "YYYY-MM-DD HH:MM:SS" UTC values without a zone marker, so normalize that
 * shape to explicit UTC. Native filesystem records already use ISO timestamps.
 */
export function parsePersistedTimestamp(s: string | null | undefined): number {
  if (!s) return NaN;
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(s)) return Date.parse(s);
  return Date.parse(s.replace(' ', 'T') + 'Z');
}

export function decisionKindOf(status: string): 'plan' | 'question' | 'tasks' | null {
  if (status === 'waiting_plan') return 'plan';
  if (status === 'waiting_question') return 'question';
  if (status === 'waiting_tasks') return 'tasks';
  return null;
}

export interface RuntimeReconcilerDeps {
  ctx: SessionContext;
  master: MasterLifecycle;
  subordinates: SubordinateLifecycle;
  masterInbox: MasterInboxRouter;
  publisher: IMetaBusPublisher;
  /** Source of truth for which subordinates are blocked awaiting a master
   *  decision (plan/question/tasks) — used by the re-nudge sweep. */
  humanInLoop: HumanInTheLoop;
  /** Attention bus used to re-wake a master parked in `wait_for_subordinates`. */
  attention: MasterAttention;
  /** Kanban service — when present, the reconciler also frees cards stranded
   *  `in_progress` by a dead agent (Phase 2 self-repair). Optional so existing
   *  callers/tests that don't need it stay untouched. */
  kanban?: KanbanService;
  /**
   * C2 — per-session autonomy config, consulted at every orphan-reset sweep
   * so `freeze`/`scheduler=false` gate it LIVE. Optional: callers/tests
   * without it fall back to `resolveAutonomy(null, process.env)`.
   */
  autonomy?: Pick<AutonomyProvider, 'get'>;
  /** Override for tests. Defaults to `Date.now()`. */
  now?: () => number;
}
