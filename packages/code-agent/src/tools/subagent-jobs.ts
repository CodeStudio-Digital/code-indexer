/**
 * subagent-jobs — process-level registry of BACKGROUND (fire-and-forget)
 * spawn_agent jobs. A `spawn_agent({background:true})` call registers a job,
 * launches the parallel worker pool WITHOUT awaiting, and returns immediately;
 * `collect_agents` waits (event-driven) for the result.
 *
 * Module-level singleton so it is reachable from spawn/collect/resume — all of
 * which execute in the same realm that runs `runCoder` (the per-session worker
 * in worker mode, the main process otherwise). Jobs are in-memory: a worker
 * crash loses them (collect then returns a clear "re-spawn" message).
 *
 * Each job owns its OWN AbortController — NEVER chained to the run signal, so
 * the run ending (which fires `operations.abortAll`) does not kill it. Only an
 * explicit `abortSession`/`abortJob` (user Stop) does.
 */
import type { ChatUsage } from '@mcp/code-agent/core/messages.js';
import type { ResearchDepth } from '@mcp/code-agent/tools/subagent-research-policy.js';
import type { SessionId } from '@mcp/session-storage';

export type JobStatus = 'running' | 'done' | 'aborted';
export type JobDelivery = 'none' | 'notified' | 'collected';

export interface BackgroundAgentSlot {
  result?: import('@mcp/agent-runtime-contracts').AgentWorkResult;
  index: number;
  label: string;
  profileId: string;
  task: string;
  status: 'pending' | 'running' | 'completed' | 'partial' | 'error' | 'timed_out' | 'aborted';
  toolCallCount: number;
  phase?: string;
  turn?: number;
  elapsedMs?: number;
  idleMs?: number;
  deadlineMs?: number;
  lastToolName?: string;
  researchDepth?: ResearchDepth;
  softToolTarget?: number;
  softTimeTargetMs?: number;
  /** Short digest of this agent's final summary — shown in the completion notice. */
  summary?: string;
}

export interface SubagentJob {
  jobId: string;
  groupId: string;
  sessionId: SessionId;
  provider: string;
  model: string;
  createdAt: number;
  finishedAt?: number;
  status: JobStatus;
  delivery: JobDelivery;
  agents: BackgroundAgentSlot[];
  resultText?: string;
  totalUsage?: ChatUsage;
  /** Number of retained child transcripts currently eligible for resume_agent. */
  resumableCount: number;
  /** True once the tokens have been added to the session totals (settle). */
  usageAccounted: boolean;
  abort: AbortController;
  /** Resolves on terminal status; never rejects. */
  settled: Promise<void>;
  resolveSettled: () => void;
}

export type WaitResult =
  | { kind: 'done'; job: SubagentJob }
  | { kind: 'timeout' }
  | { kind: 'aborted' }
  | { kind: 'empty' }
  | { kind: 'not_found' };

const DEFAULT_MAX_JOBS = 3;
const DEFAULT_COLLECTED_TTL_MS = 30 * 60_000;

export interface CreateJobArgs {
  sessionId: SessionId;
  jobId: string;
  groupId: string;
  provider: string;
  model: string;
  agents: BackgroundAgentSlot[];
}

export class SubagentJobManager {
  private readonly bySession = new Map<SessionId, Map<string, SubagentJob>>();
  private readonly activityCbs = new Set<(sessionId: SessionId, active: number) => void>();

  constructor(private readonly limits: { maxJobs?: number; collectedTtlMs?: number } = {}) {}

  create(args: CreateJobArgs): SubagentJob | { error: string } {
    this.sweep(args.sessionId);
    const maxJobs = this.limits.maxJobs ?? DEFAULT_MAX_JOBS;
    if (this.activeCount(args.sessionId) >= maxJobs) {
      return { error: `background job limit reached (${maxJobs}). collect_agents on an outstanding job before spawning more.` };
    }
    let resolveSettled!: () => void;
    const settled = new Promise<void>((res) => { resolveSettled = res; });
    const job: SubagentJob = {
      jobId: args.jobId,
      groupId: args.groupId,
      sessionId: args.sessionId,
      provider: args.provider,
      model: args.model,
      createdAt: Date.now(),
      status: 'running',
      delivery: 'none',
      agents: args.agents,
      resumableCount: 0,
      usageAccounted: false,
      abort: new AbortController(),
      settled,
      resolveSettled,
    };
    let group = this.bySession.get(args.sessionId);
    if (!group) { group = new Map(); this.bySession.set(args.sessionId, group); }
    group.set(job.jobId, job);
    this.notifyActivity(args.sessionId);
    return job;
  }

  get(sessionId: SessionId, jobId: string): SubagentJob | null {
    this.sweep(sessionId);
    return this.bySession.get(sessionId)?.get(jobId) ?? null;
  }

  list(sessionId: SessionId): SubagentJob[] {
    this.sweep(sessionId);
    return [...(this.bySession.get(sessionId)?.values() ?? [])];
  }

  patchAgent(job: SubagentJob, index: number, patch: Partial<BackgroundAgentSlot>): void {
    const slot = job.agents.find((a) => a.index === index);
    if (slot) Object.assign(slot, patch);
  }

  /** Record the terminal result. Idempotent — a second call is a no-op. */
  settle(job: SubagentJob, resultText: string, usage: ChatUsage, status: JobStatus): void {
    if (job.status !== 'running') return;
    job.status = status;
    job.resultText = resultText;
    job.totalUsage = usage;
    job.finishedAt = Date.now();
    job.resolveSettled();
    this.notifyActivity(job.sessionId);
  }

  markDelivery(job: SubagentJob, delivery: JobDelivery): void {
    // none < notified < collected — never downgrade.
    const rank = { none: 0, notified: 1, collected: 2 } as const;
    if (rank[delivery] > rank[job.delivery]) job.delivery = delivery;
  }

  hasActiveJobs(sessionId: SessionId): boolean {
    return this.activeCount(sessionId) > 0;
  }

  activeCount(sessionId: SessionId): number {
    let n = 0;
    for (const j of this.bySession.get(sessionId)?.values() ?? []) if (j.status === 'running') n++;
    return n;
  }

  abortJob(sessionId: SessionId, jobId: string, reason: string): boolean {
    const job = this.bySession.get(sessionId)?.get(jobId);
    if (!job || job.status !== 'running') return false;
    try { job.abort.abort(new Error(reason)); } catch { /* ignore */ }
    return true;
  }

  abortSession(sessionId: SessionId, reason: string): void {
    for (const j of this.bySession.get(sessionId)?.values() ?? []) {
      if (j.status === 'running') { try { j.abort.abort(new Error(reason)); } catch { /* ignore */ } }
    }
  }

  /**
   * Event-driven wait — resolves when a target job settles (no polling).
   *
   * `opts.pendingOnly` (the parking gate) considers ONLY running jobs and
   * UNDELIVERED terminals (`delivery==='none'`). Without it, an
   * already-`notified` terminal would satisfy the "terminal found" shortcut
   * on every call, so the orchestrator would busy-loop park→Executing→park
   * while another job is still running. Collect (default) instead returns any
   * not-yet-collected terminal so the agent can fetch a notified job's full
   * result.
   */
  async waitAny(
    sessionId: SessionId,
    jobIds: string[] | null,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    opts?: { pendingOnly?: boolean },
  ): Promise<WaitResult> {
    const groups = this.bySession.get(sessionId);
    if (!groups || groups.size === 0) return { kind: jobIds ? 'not_found' : 'empty' };
    const jobs = jobIds
      ? jobIds.map((id) => groups.get(id)).filter((j): j is SubagentJob => !!j)
      : [...groups.values()].filter((j) =>
          opts?.pendingOnly ? j.status === 'running' || j.delivery === 'none' : j.delivery !== 'collected',
        );
    if (jobs.length === 0) return { kind: jobIds ? 'not_found' : 'empty' };
    const terminal = jobs.find((j) => j.status !== 'running');
    if (terminal) return { kind: 'done', job: terminal };

    return await new Promise<WaitResult>((resolve) => {
      let done = false;
      const finish = (r: WaitResult) => { if (!done) { done = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(r); } };
      const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
      const onAbort = () => finish({ kind: 'aborted' });
      if (signal) {
        if (signal.aborted) return finish({ kind: 'aborted' });
        signal.addEventListener('abort', onAbort, { once: true });
      }
      for (const j of jobs) void j.settled.then(() => finish({ kind: 'done', job: j }));
    });
  }

  /** Register a keep-alive/activity observer (worker pool eviction guard). */
  onActivity(cb: (sessionId: SessionId, active: number) => void): () => void {
    this.activityCbs.add(cb);
    return () => this.activityCbs.delete(cb);
  }

  private notifyActivity(sessionId: SessionId): void {
    const active = this.activeCount(sessionId);
    for (const cb of this.activityCbs) { try { cb(sessionId, active); } catch { /* ignore */ } }
  }

  private sweep(sessionId: SessionId): void {
    const groups = this.bySession.get(sessionId);
    if (!groups) return;
    const now = Date.now();
    const ttl = this.limits.collectedTtlMs ?? DEFAULT_COLLECTED_TTL_MS;
    for (const [id, j] of groups) {
      // The TTL is post-ack cleanup only. Expiring an uncollected terminal
      // would discard its full report and silently release the completion
      // gate merely because the compact notification got old.
      if (
        j.status !== 'running'
        && j.delivery === 'collected'
        && j.finishedAt != null
        && now - j.finishedAt > ttl
      ) {
        groups.delete(id);
      }
    }
    if (groups.size === 0) this.bySession.delete(sessionId);
  }
}

let singleton: SubagentJobManager | null = null;
export function getSubagentJobManager(): SubagentJobManager {
  if (!singleton) singleton = new SubagentJobManager();
  return singleton;
}
