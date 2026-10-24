/**
 * SubordinateLifecycle — full lifecycle of a company subordinate agent:
 *   - `spawn`: create session, runCoder, wire interceptions, register
 *   - `resume`: re-run existing session with a new user message
 *   - `handleFailure`: classify transient vs permanent, auto-retry or notify
 *   - `abort` / `finalizeAll`: shutdown paths
 *
 * State owned here:
 *   - `subordinates` — handles keyed by agentRunId (alive runners)
 *   - `runningIds` — subset currently running (drains on completion)
 *
 * Every cross-service collaboration goes through narrow ports (ISP):
 *   - IMasterNotifier → notify master when subordinate blocks/fails
 *   - IBoardPoster → board announcements
 *   - IKanbanNotifier → auto-comments on completion/failure
 *   - IAgentStatusUpdater → DB status transitions
 *   - HumanInTheLoop → wire plan/question/tasks interceptions
 *   - IMetaBusWirer → forward runner events to dashboard
 *   - IIdleController → fire on subordinate count changes
 */

import type { CoderAttachment, RunCoderHandle } from '@mcp/code-agent/index/types.js';
import { RetryPolicy } from '@mcp/company/RetryPolicy.js';
import { ConcurrencyPolicy } from '@mcp/company/ConcurrencyPolicy.js';
import {
  type SubordinateHandle,
  type AgentRunStatus,
} from '@mcp/company/types.js';
import type { SessionContext } from '@mcp/company/services/SessionContext.js';
import type { HumanInTheLoop } from '@mcp/company/services/HumanInTheLoop.js';
import type { MasterAttention } from '@mcp/company/services/MasterAttention.js';
import type {
  IAgentStatusUpdater,
  IBoardPoster,
  IIdleController,
  IKanbanNotifier,
  IMasterNotifier,
  IMetaBusWirer,
  ISubordinateQuery,
} from '@mcp/company/services/ports.js';
import {
  abortSubordinate,
  pauseSubordinate,
  abortAllSubordinates,
  finalizeAllSubordinates,
  type SubordinateAbortDeps,
} from '@mcp/company/services/subordinate/abort.js';
import {
  wireSubordinateInterceptions,
  wireSubordinateInterceptionsForRunner,
} from '@mcp/company/services/subordinate/runner-wiring.js';
import {
  applySubordinateModelFallback,
  attachSubordinateCompletionHandler,
  handleSubordinateFailure,
  type SubordinateCompletionDeps,
} from '@mcp/company/services/subordinate/completion-handler.js';
import {
  resolveSpawnProjectBinding,
  resolveSpawnProjectScope,
  type SpawnSubordinateSpec,
} from '@mcp/company/services/subordinate/spec.js';
import { spawnSubordinate } from '@mcp/company/services/subordinate/spawn.js';
import { resumeSubordinate } from '@mcp/company/services/subordinate/resume.js';
import { resolveBindingForProject } from '@mcp/company/services/subordinate/binding.js';

// Re-export so existing tests / call sites that import these from
// `SubordinateLifecycle.js` keep working unchanged.
export { resolveSpawnProjectBinding, resolveSpawnProjectScope };
export type { SpawnSubordinateSpec };

// `SpawnSubordinateSpec` + `resolveSpawnProjectBinding` moved to
// `subordinate/spec.ts` to break the circular dependency with the
// extracted `spawn.ts` / `resume.ts` modules. Both are re-exported above.

export interface SubordinateLifecycleDeps {
  ctx: SessionContext;
  board: IBoardPoster;
  status: IAgentStatusUpdater;
  kanban: IKanbanNotifier;
  master: IMasterNotifier;
  humanInLoop: HumanInTheLoop;
  wirer: IMetaBusWirer;
  /**
   * Direct `IdleController` ref accepted for back-compat. Prefer
   * `eventBus` — when set, `idle` becomes a fallback for tests that
   * don't wire a bus.
   */
  idle?: IIdleController;
  /**
   * Phase 8 part 3: internal pub/sub. SubordinateLifecycle publishes
   * `subordinates.changed` whenever a spawn, abort, or status flip
   * alters the running set; IdleController subscribes through the bus.
   */
  eventBus?: import('@mcp/company/services/CompanyEventBus.js').CompanyEventBus;
  /** Facade passed into CompanyContext so tools can reach the orchestrator. */
  orchestratorRef: unknown;
  attention: MasterAttention;
  /**
   * Optional callback fired whenever a subordinate transitions to
   * `waiting` (its current task done). The orchestrator wires the
   * `InboxQueue.drainOnIdle` here so a queued message gets injected
   * as the next prompt. Set late (after the queue is constructed)
   * via `setOnSubordinateIdle`.
   */
  onSubordinateIdle?: (agentRunId: string, role: string) => void;
  /**
   * C2 — per-session autonomy config provider, forwarded to `spawnSubordinate`
   * as the source of the global-budget cap (`maxSubordinates`, default 8).
   * Optional: fixtures without it fall back to env+defaults inside spawn.
   */
  autonomy?: Pick<import('@mcp/company/services/autonomy/autonomy-provider.js').AutonomyProvider, 'get'>;
}

export class SubordinateLifecycle implements ISubordinateQuery {
  private readonly subordinates = new Map<string, SubordinateHandle>();
  private readonly runningIds = new Set<string>();
  /**
   * Synchronous spawn reservations. A spawn passes the concurrency check and
   * then awaits `runCoder` for a beat before `runningIds` gains its id — so
   * concurrent spawns (e.g. fan-out via Promise.all) would all read the same
   * pre-increment `runningIds.size` and blow past the cap (TOCTOU). The cap
   * check counts `runningIds.size + pendingSpawns.count`; each spawn reserves a
   * slot the instant it passes and releases it in a `finally`, so the window is
   * closed. A plain box (not a number) so the spawn helper mutates by reference.
   */
  private readonly pendingSpawns = { count: 0 };
  readonly retryPolicy = new RetryPolicy();
  readonly concurrencyPolicy = new ConcurrencyPolicy();

  constructor(private readonly deps: SubordinateLifecycleDeps) {}

  /** Phase 8 part 3: prefer bus; fall back to direct idle ref for tests. */
  private notifyIdleChanged(): void {
    if (this.deps.eventBus) this.deps.eventBus.emit({ type: 'subordinates.changed' });
    else this.deps.idle?.onSubordinatesChanged();
  }

  /**
   * Late-bind the idle callback. Used by the orchestrator to wire
   * `InboxQueue.drainOnIdle` after both services have been constructed
   * (the queue depends on `SubordinateLifecycle.reactivate`).
   */
  setOnSubordinateIdle(cb: (agentRunId: string, role: string) => void): void {
    this.deps.onSubordinateIdle = cb;
  }

  // ─── ISubordinateQuery ──────────────────────────────────────────

  get runningCount(): number { return this.runningIds.size; }
  /** Includes synchronous spawn reservations that have not created a run yet. */
  get concurrencyOccupancy(): number { return this.runningIds.size + this.pendingSpawns.count; }
  isRunning(agentRunId: string): boolean { return this.runningIds.has(agentRunId); }

  // ─── Queries ────────────────────────────────────────────────────

  get(agentRunId: string): SubordinateHandle | undefined {
    return this.subordinates.get(agentRunId);
  }

  list(): Array<{
    agentRunId: string;
    seq: number;
    role: string;
    status: AgentRunStatus;
    statusMessage: string;
    projectIds: number[];
    provider: string;
    model: string;
    coderSessionId: string;
    isAlive: boolean;
  }> {
    const runs = this.deps.ctx.companyFiles.listAgentRunsSync();
    return runs
      .filter((r) => r.role !== 'master')
      .map((r) => ({
        agentRunId: r.id,
        seq: r.seq,
        role: r.role,
        status: r.status as AgentRunStatus,
        statusMessage: r.status_message ?? '',
        projectIds: JSON.parse(r.project_ids_json),
        provider: r.provider,
        model: r.model,
        coderSessionId: r.coder_session_id,
        isAlive: this.subordinates.has(r.id),
      }));
  }

  statusOf(agentRunId: string): AgentRunStatus | null {
    const run = this.deps.ctx.companyFiles.getAgentRunSync(agentRunId);
    return run ? (run.status as AgentRunStatus) : null;
  }

  /**
   * Pick the sandbox binding a subordinate should operate against.
   *
   * Microservice projects are linked to the session via
   * `company_session_projects.label = serviceId`; each has its own
   * container whose bind-mount is a distinct `data/virtual-projects/
   * <uuid>` host dir. If a subordinate uses the primary master
   * binding when its project is actually a secondary service, every
   * `write_file` / `run_command` lands in the master's workdir —
   * silently corrupting it while leaving the service workdir empty.
   *
   * Resolution:
   *   project has label + that label has a live service binding
   *     → use the service binding
   *   project's root_path equals the primary container's hostWorkdirMount
   *     (i.e. THIS project is the one bind-mounted into the primary)
   *     → use the primary master binding
   *   otherwise (host-only project linked to a builder session, or
   *     service container not yet up)
   *     → return null so the subordinate runs on the host filesystem
   *       at its own root_path. Falling back to the primary binding
   *       here would ship the agent into the WRONG project's container
   *       workdir — that's the "backend agent edits files in the React
   *       container" bug.
   */
  private resolveBindingForProject(
    projectId: number,
  ): import('@mcp/company/types.js').SandboxBinding | null {
    return resolveBindingForProject(this.deps.ctx, this.deps.orchestratorRef, projectId);
  }

  // ─── Spawn ──────────────────────────────────────────────────────

  async spawn(spec: SpawnSubordinateSpec): Promise<{
    agentRunId: string;
    coderSessionId: string;
    status: AgentRunStatus;
  }> {
    return spawnSubordinate(spec, this.buildSpawnDeps());
  }

  // ─── Resume ─────────────────────────────────────────────────────

  async resume(
    agentRunId: string,
    message?: string,
    roleOverride?: string,
    attachments?: CoderAttachment[],
    thinking?: boolean,
  ): Promise<{
    agentRunId: string;
    coderSessionId: string;
    status: AgentRunStatus;
  }> {
    return resumeSubordinate(
      agentRunId,
      message,
      roleOverride,
      attachments,
      thinking,
      this.buildResumeDeps(),
    );
  }

  /** Build the deps bag passed to `spawnSubordinate`. */
  private buildSpawnDeps() {
    return {
      ctx: this.deps.ctx,
      board: this.deps.board,
      status: this.deps.status,
      kanban: this.deps.kanban,
      master: this.deps.master,
      humanInLoop: this.deps.humanInLoop,
      wirer: this.deps.wirer,
      attention: this.deps.attention,
      orchestratorRef: this.deps.orchestratorRef,
      concurrencyPolicy: this.concurrencyPolicy,
      subordinates: this.subordinates,
      runningIds: this.runningIds,
      pendingSpawns: this.pendingSpawns,
      notifyIdleChanged: () => this.notifyIdleChanged(),
      wireDeps: {
        humanInLoop: this.deps.humanInLoop,
        wirer: this.deps.wirer,
      },
      completionDeps: this.completionDeps,
      listRunning: () => this.list().map((s) => ({ agentRunId: s.agentRunId, role: s.role })),
      autonomy: this.deps.autonomy,
    };
  }

  /** Build the deps bag passed to `resumeSubordinate`. */
  private buildResumeDeps() {
    return {
      ctx: this.deps.ctx,
      board: this.deps.board,
      status: this.deps.status,
      master: this.deps.master,
      humanInLoop: this.deps.humanInLoop,
      wirer: this.deps.wirer,
      orchestratorRef: this.deps.orchestratorRef,
      subordinates: this.subordinates,
      runningIds: this.runningIds,
      notifyIdleChanged: () => this.notifyIdleChanged(),
      wireDeps: {
        humanInLoop: this.deps.humanInLoop,
        wirer: this.deps.wirer,
      },
      completionDeps: this.completionDeps,
    };
  }

  /**
   * Reactivate a waiting/completed/errored/aborted subordinate. Returns
   * false if the agent run doesn't exist or isn't in a resumable state.
   */
  async reactivate(agentRunId: string, message: string, attachments?: CoderAttachment[], thinking?: boolean): Promise<boolean> {
    const agentRun = this.deps.ctx.companyFiles.getAgentRunSync(agentRunId);
    if (!agentRun) return false;
    const resumableStatuses = ['error', 'aborted', 'paused', 'waiting', 'completed', 'interrupted'];
    if (!resumableStatuses.includes(agentRun.status)) {
      console.warn(`[company] Cannot reactivate ${agentRun.role}: status is ${agentRun.status}`);
      return false;
    }
    try {
      await this.resume(agentRunId, message, undefined, attachments, thinking);
      return true;
    } catch (e) {
      console.warn(`[company] Failed to reactivate ${agentRun.role}: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  // ─── Shutdown paths ─────────────────────────────────────────────

  abort(agentRunId: string): boolean {
    return abortSubordinate(agentRunId, this.abortDeps);
  }

  /** Pause a running subordinate (resumable). See `pauseSubordinate`. */
  pause(agentRunId: string): boolean {
    return pauseSubordinate(agentRunId, this.abortDeps);
  }

  abortAll(): void {
    abortAllSubordinates(this.abortDeps);
  }

  /** Gracefully terminate all subordinates (master-driven finalization). */
  finalizeAll(): { finalized: number; alreadyStopped: number } {
    return finalizeAllSubordinates(this.abortDeps);
  }

  /** Build the shared deps bag for the abort/abortAll/finalizeAll helpers. */
  private get abortDeps(): SubordinateAbortDeps {
    return {
      ctx: this.deps.ctx,
      board: this.deps.board,
      status: this.deps.status,
      humanInLoop: this.deps.humanInLoop,
      attention: this.deps.attention,
      subordinates: this.subordinates,
      runningIds: this.runningIds,
    };
  }

  // ─── Internal: failure classifier ───────────────────────────────

  /** Bundle the deps for the completion-handler module. Built lazily. */
  private get completionDeps(): SubordinateCompletionDeps {
    return {
      ctx: this.deps.ctx,
      board: this.deps.board,
      status: this.deps.status,
      kanban: this.deps.kanban,
      master: this.deps.master,
      attention: this.deps.attention,
      retryPolicy: this.retryPolicy,
      orchestratorRef: this.deps.orchestratorRef,
      runningIds: this.runningIds,
      notifyIdleChanged: () => this.notifyIdleChanged(),
      isCurrentHandle: (agentRunId, handle) =>
        this.subordinates.get(agentRunId)?.runner === handle.runner,
      resume: (id, message, roleOverride, attachments, thinking) =>
        this.resume(id, message, roleOverride, attachments, thinking),
      onSubordinateIdle: this.deps.onSubordinateIdle,
    };
  }

  private applyModelFallback(
    agentRunId: string,
    role: string,
  ): Promise<{ from: { provider: string; model: string }; to: { provider: string; model: string } } | null> {
    return applySubordinateModelFallback(agentRunId, role, this.completionDeps);
  }

  private handleFailure(
    agentRunId: string,
    role: string,
    summary: string,
    errorDetail: string | null,
  ): Promise<void> {
    return handleSubordinateFailure(agentRunId, role, summary, errorDetail, this.completionDeps);
  }

  // ─── Internal: wiring helpers ───────────────────────────────────

  private wireInterceptions(handle: RunCoderHandle, agentRunId: string, role: string): void {
    wireSubordinateInterceptions(handle, agentRunId, role, {
      humanInLoop: this.deps.humanInLoop,
      wirer: this.deps.wirer,
    });
  }

  private wireInterceptionsForRunner(
    runner: import('@mcp/code-agent/core/runner.js').CoderRunner,
    agentRunId: string,
    role: string,
  ): void {
    wireSubordinateInterceptionsForRunner(runner, agentRunId, role, {
      humanInLoop: this.deps.humanInLoop,
      wirer: this.deps.wirer,
    });
  }

  private attachCompletionHandler(
    handle: RunCoderHandle,
    agentRunId: string,
    role: string,
    isResumed: boolean,
  ): void {
    attachSubordinateCompletionHandler(handle, agentRunId, role, isResumed, this.completionDeps);
  }
}
