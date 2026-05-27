/**
 * C7 — InboxRoutingPipeline (Sprint 3.5).
 *
 * Replaces the deterministic `InboxQueue.resolveTargetRunId()` with a
 * `CandidatePipeline<InboxRoutingQuery, AgentRunCandidate>`. The
 * framework gives us:
 *   - **Failover semantics**: Sources can fan out beyond the exact role
 *     (e.g. `IdleAlternativeRolesSource` for cross-role fallback).
 *   - **Pluggable filters**: `HealthFilter` reuses the C6 assessment
 *     logic; future filters drop runs that just failed a previous send.
 *   - **Pluggable scorers**: `LoadScorer` (smallest backlog wins, same as
 *     legacy), `RecencyScorer` (recently active > stale), `RoleFitScorer`
 *     (skill overlap — when role descriptors carry skills).
 *   - **Telemetry**: per-stage rows in `pipeline_telemetry` so admin can
 *     watch routing decisions.
 *
 * **Sprint 3.5 minimum**: ships ONE source (`RoleMatchingSubordinatesSource`)
 * + ONE filter (`HealthFilter`) + ONE scorer (`LoadScorer`) + selector.
 * Match the legacy routing decision exactly when flag enabled, but via
 * the framework. Failover sources/scorers are plug-in additions for
 * follow-up.
 *
 * **Gated**: `MCP_PIPELINES_INBOX_ROUTING=1`. Default OFF → InboxQueue
 * uses `resolveTargetRunId()` exactly as before — bit-identical to
 * pre-C7 behavior.
 */
import {
  CandidatePipeline,
  TopKSelector,
  type Filter,
  type PipelineCandidate,
  type PipelineQuery,
  type Scorer,
  type Source,
  type TelemetrySink,
} from '@mcp/candidate-pipeline';
import type { CompanyAgentRun } from '@mcp/company-contracts/models/agent-run.js';
import type { AgentInboxMessage } from '@mcp/company-contracts/models/inbox.js';

/** Live workflow inputs for routing decisions. */
export interface InboxRoutingQuery extends PipelineQuery {
  companySessionId: number;
  /** Target role from the SendArgs (may be undefined if toAgentRunId passed directly). */
  toRole?: string;
  /** Direct target run when caller addressed a specific run. */
  toAgentRunId?: number;
  /**
   * Snapshot of agent runs in this session. Captured ONCE per send and
   * passed in so sources don't re-query — keeps the pipeline pure.
   */
  agentRuns: ReadonlyArray<CompanyAgentRun>;
  /**
   * Pending+delivered inbox messages keyed by `toAgentRunId`. Captured
   * once per send.
   */
  pendingByRunId: ReadonlyMap<number, ReadonlyArray<AgentInboxMessage>>;
}

/** A single agent_run candidate. */
export interface AgentRunCandidate extends PipelineCandidate {
  run: CompanyAgentRun;
  /** Pending+delivered message count for this run. Set by HealthFilter. */
  pendingCount: number;
  /** Final fused score; smallest score = best target (we invert below). */
  score: number;
  signals: {
    /** Inverse-load signal: 1 / (1 + pending). Higher = lighter load. */
    loadFitness?: number;
    /** Recency in ms since last update — smaller = fresher. */
    ageMs?: number;
  };
}

function emptyCandidate(run: CompanyAgentRun, pending: number): AgentRunCandidate {
  return {
    candidateId: `run:${run.id}`,
    run,
    pendingCount: pending,
    score: 0,
    signals: {},
  };
}

// ─── Source: roles matching the target ───────────────────────────────

/**
 * Emit every `agent_run` whose role matches `toRole` (or just the
 * specific `toAgentRunId` when explicit). Master is always excluded.
 */
export class RoleMatchingSubordinatesSource
  implements Source<InboxRoutingQuery, AgentRunCandidate>
{
  readonly name = 'role_matching';

  enable(q: InboxRoutingQuery): boolean {
    // No targeting info → nothing to do.
    return q.toAgentRunId !== undefined || (q.toRole !== undefined && q.toRole.length > 0);
  }

  async source(q: InboxRoutingQuery): Promise<AgentRunCandidate[]> {
    const out: AgentRunCandidate[] = [];
    for (const run of q.agentRuns) {
      if (run.role === 'master') continue;
      if (q.toAgentRunId !== undefined && run.id !== q.toAgentRunId) continue;
      if (q.toAgentRunId === undefined && q.toRole && run.role !== q.toRole) continue;
      const pending = q.pendingByRunId.get(run.id)?.length ?? 0;
      out.push(emptyCandidate(run, pending));
    }
    return out;
  }
}

// ─── Filter: health (C6 reused conceptually) ─────────────────────────

const FAILED_STATUSES = new Set(['error', 'aborted', 'interrupted']);

function resolveMaxPendingForRouting(): number {
  const raw = process.env.MCP_COMPANY_INBOX_MAX_PENDING;
  if (!raw) return 3;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3;
}

/**
 * Drop candidates that are NOT routable:
 *   - status in {error, aborted, interrupted}
 *   - pending count ≥ MCP_COMPANY_INBOX_MAX_PENDING (default 3)
 *
 * Mirrors C6's `assessTargetHealth` failure criteria but on the
 * candidate set (so multiple alternatives can survive the filter).
 */
export class HealthFilter implements Filter<InboxRoutingQuery, AgentRunCandidate> {
  readonly name = 'health';

  enable(): boolean {
    return true;
  }

  filter(
    _q: InboxRoutingQuery,
    candidates: AgentRunCandidate[],
  ): { kept: AgentRunCandidate[]; removed: AgentRunCandidate[] } {
    const maxPending = resolveMaxPendingForRouting();
    const kept: AgentRunCandidate[] = [];
    const removed: AgentRunCandidate[] = [];
    for (const c of candidates) {
      if (FAILED_STATUSES.has(c.run.status)) {
        removed.push(c);
        continue;
      }
      if (c.pendingCount >= maxPending) {
        removed.push(c);
        continue;
      }
      kept.push(c);
    }
    return { kept, removed };
  }
}

// ─── Scorer: load balancing (smaller backlog = higher score) ─────────

/**
 * Computes `loadFitness = 1 / (1 + pendingCount)` so that candidates
 * with zero pending get score 1.0 and the score asymptotes toward 0 as
 * the backlog grows. Identical RANKING to the legacy "smallest backlog
 * wins" (resolveTargetRunId), but the framework selector handles the
 * top-K choice — no inline imperative.
 */
export class LoadScorer implements Scorer<InboxRoutingQuery, AgentRunCandidate> {
  readonly name = 'load';

  enable(): boolean {
    return true;
  }

  async score(
    _q: InboxRoutingQuery,
    candidates: readonly AgentRunCandidate[],
  ): Promise<Array<{ ok: true; candidate: AgentRunCandidate }>> {
    return candidates.map((c) => {
      const loadFitness = 1 / (1 + c.pendingCount);
      return {
        ok: true as const,
        candidate: {
          ...c,
          score: loadFitness,
          signals: { ...c.signals, loadFitness },
        },
      };
    });
  }

  update(target: AgentRunCandidate, scored: AgentRunCandidate): void {
    target.score = scored.score;
    target.signals = scored.signals;
  }
}

// ─── Factory ──────────────────────────────────────────────────────────

export interface CreateInboxRoutingPipelineOptions {
  telemetry?: TelemetrySink;
}

export function createInboxRoutingPipeline(
  opts: CreateInboxRoutingPipelineOptions = {},
): CandidatePipeline<InboxRoutingQuery, AgentRunCandidate> {
  return new CandidatePipeline<InboxRoutingQuery, AgentRunCandidate>(
    { name: 'inbox_routing', telemetry: opts.telemetry },
    {
      sources: [new RoleMatchingSubordinatesSource()],
      filters: [new HealthFilter()],
      scorers: [new LoadScorer()],
      selector: new TopKSelector<InboxRoutingQuery, AgentRunCandidate>({
        k: 1,
        scoreOf: (c) => c.score,
      }),
    },
  );
}

/**
 * Convenience: run the pipeline and return the chosen run id + the
 * remaining failover list. Caller's perspective stays close to the
 * legacy `resolveTargetRunId` (single id or null).
 */
export interface RoutingDecision {
  /** Best target — null when no healthy candidate exists. */
  targetRunId: number | null;
  /** Other candidates ranked below the winner — for retry on failure. */
  failoverRunIds: ReadonlyArray<number>;
  /** Removed candidates with their reasons (for telemetry / diagnostics). */
  rejected: ReadonlyArray<{ runId: number; reason: 'failed_status' | 'overloaded' }>;
}

export async function routeInbox(
  pipeline: CandidatePipeline<InboxRoutingQuery, AgentRunCandidate>,
  query: InboxRoutingQuery,
): Promise<RoutingDecision> {
  const result = await pipeline.execute(query);
  const winner = result.selected[0];
  // Reconstruct rejection reasons from removed candidates. The
  // CandidatePipeline framework returns ALL non-selected, including
  // filter-rejected — we re-derive the reason here from the stored
  // pendingCount/status (cheaper than mutating candidates with reason
  // metadata which is a code-shape choice we want to defer).
  const maxPending = resolveMaxPendingForRouting();
  const rejected: Array<{ runId: number; reason: 'failed_status' | 'overloaded' }> = [];
  // Selector's non-selected includes both filter-rejected and runners-up.
  // We only flag candidates that genuinely failed health — runners-up
  // are NOT rejections.
  for (const c of result.nonSelected) {
    if (FAILED_STATUSES.has(c.run.status)) {
      rejected.push({ runId: c.run.id, reason: 'failed_status' });
    } else if (c.pendingCount >= maxPending) {
      rejected.push({ runId: c.run.id, reason: 'overloaded' });
    }
  }
  // Runners-up — candidates that passed health but lost to the winner.
  const failoverRunIds = result.nonSelected
    .filter((c) => !FAILED_STATUSES.has(c.run.status) && c.pendingCount < maxPending)
    .map((c) => c.run.id);

  return {
    targetRunId: winner?.run.id ?? null,
    failoverRunIds,
    rejected,
  };
}
