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

import { runCoder, type RunCoderOptions, type RunCoderHandle } from '../../index.js';
import { createBus } from '../../../../apps/http-api/coder-bus.js';
import { SessionStore } from '../../sessions/store.js';
import { SkillStore } from '../../../../store/skill-store.js';
import { loadConfig } from '../../../../utils/config.js';
import { buildSubordinateCompanyBlock } from '../system-prompts.js';
import { RetryPolicy } from '../RetryPolicy.js';
import { ConcurrencyPolicy } from '../ConcurrencyPolicy.js';
import type {
  CompanyContext,
  SubordinateHandle,
  AgentRunStatus,
} from '../types.js';
import type { SessionContext } from './SessionContext.js';
import type { HumanInTheLoop } from './HumanInTheLoop.js';
import type {
  IAgentStatusUpdater,
  IBoardPoster,
  IIdleController,
  IKanbanNotifier,
  IMasterNotifier,
  IMetaBusWirer,
  ISubordinateQuery,
} from './ports.js';

export interface SpawnSubordinateSpec {
  role: string;
  task: string;
  projectId: number;
  provider?: string;
  model?: string;
  tier?: 'bootstrap' | 'navigate' | 'full';
  wait?: boolean;
  skills?: string[];
}

export interface SubordinateLifecycleDeps {
  ctx: SessionContext;
  board: IBoardPoster;
  status: IAgentStatusUpdater;
  kanban: IKanbanNotifier;
  master: IMasterNotifier;
  humanInLoop: HumanInTheLoop;
  wirer: IMetaBusWirer;
  idle: IIdleController;
  /** Facade passed into CompanyContext so tools can reach the orchestrator. */
  orchestratorRef: unknown;
}

export class SubordinateLifecycle implements ISubordinateQuery {
  private readonly subordinates = new Map<number, SubordinateHandle>();
  private readonly runningIds = new Set<number>();
  readonly retryPolicy = new RetryPolicy();
  readonly concurrencyPolicy = new ConcurrencyPolicy();

  constructor(private readonly deps: SubordinateLifecycleDeps) {}

  // ─── ISubordinateQuery ──────────────────────────────────────────

  get runningCount(): number { return this.runningIds.size; }
  isRunning(agentRunId: number): boolean { return this.runningIds.has(agentRunId); }

  // ─── Queries ────────────────────────────────────────────────────

  get(agentRunId: number): SubordinateHandle | undefined {
    return this.subordinates.get(agentRunId);
  }

  list(): Array<{
    agentRunId: number;
    role: string;
    status: AgentRunStatus;
    statusMessage: string;
    projectIds: number[];
    provider: string;
    model: string;
    coderSessionId: number;
    isAlive: boolean;
  }> {
    const runs = this.deps.ctx.companyStore.listAgentRuns(this.deps.ctx.companySessionId);
    return runs
      .filter((r) => r.role !== 'master')
      .map((r) => ({
        agentRunId: r.id,
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

  statusOf(agentRunId: number): AgentRunStatus | null {
    const run = this.deps.ctx.companyStore.getAgentRun(agentRunId);
    return run ? (run.status as AgentRunStatus) : null;
  }

  // ─── Spawn ──────────────────────────────────────────────────────

  async spawn(spec: SpawnSubordinateSpec): Promise<{
    agentRunId: number;
    coderSessionId: number;
    status: AgentRunStatus;
  }> {
    const ctx = this.deps.ctx;
    if (!ctx.projects.some((p) => p.project_id === spec.projectId)) {
      throw new Error(
        `Project ${spec.projectId} is not linked to company session ${ctx.companySessionId}`,
      );
    }

    // Concurrency cap — protects against unbounded parallel spawns.
    const check = this.concurrencyPolicy.check(this.runningIds.size);
    if (!check.ok) {
      const running = this.list()
        .filter((s) => this.runningIds.has(s.agentRunId))
        .map((s) => `${s.role}(run=${s.agentRunId})`)
        .join(', ');
      throw new Error(
        `spawnSubordinate refused (${check.current}/${check.max}). Running: ${running}. ${check.message}`,
      );
    }

    const config = loadConfig();
    const store = new SessionStore(config.dbPath);

    const provider = spec.provider ?? 'anthropic';
    const model = spec.model ?? 'claude-sonnet-4-6';
    const project = ctx.db.getProject(spec.projectId);
    const projectName = project?.name ?? `project-${spec.projectId}`;

    this.deps.board.post('system', null, 'message',
      `Spawned @${spec.role} agent (project: ${projectName}, ${provider}/${model})`);

    const subSession = store.createSession({
      project_id: spec.projectId,
      title: `[Company ${spec.role}] ${ctx.companySessionId}`,
      provider,
      model,
    });

    // Inherit master's disabled tool config so subordinates respect the same
    // tool restrictions the user configured for this company session.
    const masterHandle = this.deps.master.handle;
    if (masterHandle) {
      try {
        store.copyToolConfig(masterHandle.session.id, subSession.id);
      } catch (e) {
        console.warn(`[company] Failed to copy tool config to ${spec.role}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (spec.skills && spec.skills.length > 0) {
      try {
        const skillStore = new SkillStore(config.dbPath);
        const allSkills = skillStore.resolveActiveSkills(subSession.id, spec.projectId);
        for (const skill of allSkills) {
          skillStore.setSessionSkillEnabled(subSession.id, skill.id, spec.skills.includes(skill.id));
        }
        skillStore.close();
      } catch (e) {
        console.warn(`[company] Failed to configure skills for ${spec.role}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const agentRun = ctx.companyStore.createAgentRun({
      company_session_id: ctx.companySessionId,
      role: spec.role,
      coder_session_id: subSession.id,
      project_ids: [spec.projectId],
      provider,
      model,
    });

    const companyContext: CompanyContext = {
      orchestrator: this.deps.orchestratorRef as never,
      companySessionId: ctx.companySessionId,
      agentRole: spec.role,
      agentRunId: agentRun.id,
      allowedProjectIds: [spec.projectId],
      isMaster: false,
    };

    const subordinateBlock = buildSubordinateCompanyBlock({
      role: spec.role,
      projects: [{
        id: spec.projectId,
        name: projectName,
        rootPath: project?.root_path ?? '',
      }],
    });

    const handle = await runCoder({
      session: { id: subSession.id },
      userMessage: spec.task,
      maxTurns: 50,
      profile: spec.tier ?? 'navigate',
      companyContext,
      companyPromptBlock: subordinateBlock,
    } as RunCoderOptions & { companyPromptBlock: string });

    this.wireInterceptions(handle, agentRun.id, spec.role);

    this.deps.status.setStatus(agentRun.id, 'running');
    this.runningIds.add(agentRun.id);
    this.deps.idle.onSubordinatesChanged();

    const subordinateHandle: SubordinateHandle = {
      agentRunId: agentRun.id,
      role: spec.role,
      projectIds: [spec.projectId],
      session: subSession,
      runner: handle.runner,
      bus: createBus(new AbortController()),
      done: handle.done,
    };
    this.subordinates.set(agentRun.id, subordinateHandle);

    this.attachCompletionHandler(handle, agentRun.id, spec.role, false);

    store.close();

    if (spec.wait) await handle.done;

    return {
      agentRunId: agentRun.id,
      coderSessionId: subSession.id,
      status: 'running',
    };
  }

  // ─── Resume ─────────────────────────────────────────────────────

  async resume(agentRunId: number, message?: string): Promise<{
    agentRunId: number;
    coderSessionId: number;
    status: AgentRunStatus;
  }> {
    const ctx = this.deps.ctx;
    const agentRun = ctx.companyStore.getAgentRun(agentRunId);
    if (!agentRun) throw new Error(`Agent run ${agentRunId} not found`);
    if (agentRun.company_session_id !== ctx.companySessionId) {
      throw new Error(`Agent run ${agentRunId} does not belong to this company session`);
    }
    const resumableStatuses = ['error', 'aborted', 'waiting', 'completed', 'interrupted'];
    if (!resumableStatuses.includes(agentRun.status)) {
      throw new Error(
        `Agent run ${agentRunId} status is ${agentRun.status}, not resumable (need: ${resumableStatuses.join('/')})`,
      );
    }

    const config = loadConfig();
    const store = new SessionStore(config.dbPath);
    const projectIds: number[] = JSON.parse(agentRun.project_ids_json);
    const projectId = projectIds[0];
    const project = ctx.db.getProject(projectId);

    const companyContext: CompanyContext = {
      orchestrator: this.deps.orchestratorRef as never,
      companySessionId: ctx.companySessionId,
      agentRole: agentRun.role,
      agentRunId: agentRun.id,
      allowedProjectIds: projectIds,
      isMaster: false,
    };

    const subordinateBlock = buildSubordinateCompanyBlock({
      role: agentRun.role,
      projects: [{
        id: projectId,
        name: project?.name ?? `project-${projectId}`,
        rootPath: project?.root_path ?? '',
      }],
    });

    const resumeMessage = message ?? 'Continue your task from where you left off. Check the board for context.';

    this.deps.board.post('system', agentRun.id, 'message', `Resuming @${agentRun.role} agent...`);

    let handle: Awaited<ReturnType<typeof runCoder>>;
    try {
      handle = await runCoder({
        session: { id: agentRun.coder_session_id },
        userMessage: resumeMessage,
        maxTurns: 50,
        companyContext,
        companyPromptBlock: subordinateBlock,
      } as RunCoderOptions & { companyPromptBlock: string });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      this.deps.status.setStatus(agentRun.id, 'error', `Resume failed: ${detail}`);
      this.deps.board.post('system', agentRun.id, 'message', `@${agentRun.role} resume FAILED: ${detail}`);
      this.deps.master.notify(
        `[SYSTEM] @${agentRun.role} (agent_run_id=${agentRun.id}) resume FAILED: ${detail}. ` +
        `Use spawn_subordinate_agent for a fresh start.`,
      );
      store.close();
      throw e;
    }

    this.wireInterceptions(handle, agentRun.id, agentRun.role);
    this.deps.status.setStatus(agentRun.id, 'running');
    this.runningIds.add(agentRun.id);
    this.deps.idle.onSubordinatesChanged();

    const subordinateHandle: SubordinateHandle = {
      agentRunId: agentRun.id,
      role: agentRun.role,
      projectIds,
      session: store.getSession(agentRun.coder_session_id)!,
      runner: handle.runner,
      bus: createBus(new AbortController()),
      done: handle.done,
    };
    this.subordinates.set(agentRun.id, subordinateHandle);

    this.attachCompletionHandler(handle, agentRun.id, agentRun.role, true);

    store.close();
    return {
      agentRunId: agentRun.id,
      coderSessionId: agentRun.coder_session_id,
      status: 'running',
    };
  }

  /**
   * Reactivate a waiting/completed/errored/aborted subordinate. Returns
   * false if the agent run doesn't exist or isn't in a resumable state.
   */
  async reactivate(agentRunId: number, message: string): Promise<boolean> {
    const agentRun = this.deps.ctx.companyStore.getAgentRun(agentRunId);
    if (!agentRun) return false;
    const resumableStatuses = ['error', 'aborted', 'waiting', 'completed', 'interrupted'];
    if (!resumableStatuses.includes(agentRun.status)) {
      console.warn(`[company] Cannot reactivate ${agentRun.role}: status is ${agentRun.status}`);
      return false;
    }
    try {
      await this.resume(agentRunId, message);
      return true;
    } catch (e) {
      console.warn(`[company] Failed to reactivate ${agentRun.role}: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  // ─── Shutdown paths ─────────────────────────────────────────────

  abort(agentRunId: number): boolean {
    const sub = this.subordinates.get(agentRunId);
    if (!sub) return false;
    sub.runner.abort();
    this.deps.humanInLoop.clearForAgent(agentRunId);
    this.deps.status.setStatus(agentRunId, 'aborted');
    return true;
  }

  abortAll(): void {
    for (const sub of this.subordinates.values()) {
      sub.runner.abort();
      this.deps.status.setStatus(sub.agentRunId, 'aborted');
    }
  }

  /** Gracefully terminate all subordinates (master-driven finalization). */
  finalizeAll(): { finalized: number; alreadyStopped: number } {
    let finalized = 0;
    let alreadyStopped = 0;
    const runs = this.deps.ctx.companyStore.listAgentRuns(this.deps.ctx.companySessionId);
    const subs = runs.filter((r) => r.role !== 'master');

    for (const run of subs) {
      const handle = this.subordinates.get(run.id);
      if (this.runningIds.has(run.id) && handle) {
        handle.runner.abort();
        this.runningIds.delete(run.id);
        finalized++;
      } else {
        alreadyStopped++;
      }
      this.deps.status.setStatus(run.id, 'completed', 'Finalized by master');
    }

    this.subordinates.clear();
    this.runningIds.clear();
    this.deps.humanInLoop.clearAll();
    this.deps.board.post('system', null, 'message',
      `All subordinates finalized: ${finalized} stopped, ${alreadyStopped} were already idle.`);
    return { finalized, alreadyStopped };
  }

  // ─── Internal: failure classifier ───────────────────────────────

  /**
   * Unified failure handler. Classifies the error:
   *   - Transient (429/5xx/timeout/network) → auto-retry via RetryPolicy
   *   - Permanent → notify master immediately with recovery hint.
   */
  private handleFailure(
    agentRunId: number,
    role: string,
    summary: string,
    errorDetail: string | null,
  ): void {
    this.deps.status.setStatus(agentRunId, 'error', `Ended: ${summary}`);
    this.deps.board.post('system', agentRunId, 'message', `@${role} ${summary}`);

    if (this.retryPolicy.shouldRetry(agentRunId, errorDetail)) {
      const attempt = this.retryPolicy.usedCount(agentRunId);
      const max = this.retryPolicy.maxAttempts;
      this.deps.board.post('system', agentRunId, 'message',
        `[AUTO-RETRY] @${role} — transient error, retrying (${attempt}/${max})`);
      try {
        const cardId = this.deps.kanban.findCardForAgent(agentRunId);
        if (cardId) {
          this.deps.kanban.addComment(cardId, role, agentRunId,
            `[AUTO-RETRY] Transient error; attempt ${attempt}/${max}: ${errorDetail ?? 'unknown'}`);
        }
      } catch { /* best-effort */ }

      void this.resume(agentRunId,
        `[SYSTEM] Previous run ended with transient error (${errorDetail ?? 'unknown'}). ` +
        `Auto-retrying attempt ${attempt}/${max}. Continue the task.`,
      ).catch((e) => {
        console.warn(`[company] auto-retry failed for ${role}#${agentRunId}:`, e);
        this.deps.master.notify(
          `[SYSTEM] @${role} (agent_run_id=${agentRunId}) auto-retry FAILED to start: ${e instanceof Error ? e.message : String(e)}. ` +
          `Use resume_subordinate to retry manually or spawn_subordinate_agent for a fresh start.`,
        );
      });
      return;
    }

    // Permanent — notify master with recovery hint.
    this.deps.master.notify(
      `[SYSTEM] @${role} (agent_run_id=${agentRunId}) ended: ${summary}. ` +
      `Use resume_subordinate to retry or spawn_subordinate_agent for a fresh start.`,
    );
    try {
      const cardId = this.deps.kanban.findCardForAgent(agentRunId);
      if (cardId) {
        this.deps.kanban.addComment(cardId, role, agentRunId,
          `[AUTO] Agent ended: ${summary}. Card may need attention.`);
      }
    } catch { /* best-effort */ }
  }

  // ─── Internal: wiring helpers ───────────────────────────────────

  private wireInterceptions(handle: RunCoderHandle, agentRunId: number, role: string): void {
    this.deps.humanInLoop.wireSubordinatePlan(handle, agentRunId, role);
    this.deps.humanInLoop.wireSubordinateQuestion(handle, agentRunId, role);
    this.deps.humanInLoop.wireSubordinateTasks(handle, agentRunId, role);
    this.deps.wirer.wire(handle, role, agentRunId);
  }

  private attachCompletionHandler(
    handle: RunCoderHandle,
    agentRunId: number,
    role: string,
    isResumed: boolean,
  ): void {
    const resumedTag = isResumed ? ' (resumed)' : '';

    handle.done
      .then(({ reason, error }) => {
        if (reason === 'completed') {
          this.retryPolicy.clear(agentRunId);
          this.deps.status.setStatus(agentRunId, 'waiting', 'Task done. Ready for next task.');
          this.deps.board.post('system', agentRunId, 'deliverable',
            `@${role}${resumedTag} finished task. Status: **waiting** for next instructions.`);
          this.deps.master.notify(
            `[SYSTEM] @${role} (agent_run_id=${agentRunId}${resumedTag}) completed and is WAITING. ` +
            `Use forward_to_agent to give it another task (keeps full context), ` +
            `or spawn_subordinate_agent for unrelated work.`,
          );
          try {
            const cardId = this.deps.kanban.findCardForAgent(agentRunId);
            if (cardId) {
              this.deps.kanban.addComment(cardId, role, agentRunId,
                `[AUTO] Agent completed successfully${resumedTag}. Status: waiting for next instructions.`);
            }
          } catch { /* best-effort */ }
        } else {
          const detail = error ? ` — ${error}` : '';
          this.handleFailure(agentRunId, role, `${reason}${detail}`, error ?? null);
        }
      })
      .catch((err) => {
        const detail = err instanceof Error ? err.message : String(err);
        this.handleFailure(agentRunId, role, `FAILED: ${detail}`, detail);
      })
      .finally(() => {
        this.runningIds.delete(agentRunId);
        this.deps.idle.onSubordinatesChanged();
      });
  }
}
