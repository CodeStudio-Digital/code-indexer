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
import type { MasterAttention } from './MasterAttention.js';
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
  /**
   * Project id to run the subordinate in. Optional when the role has a
   * single-project binding (`CompanyRoleConfig.projectIds.length === 1`):
   * in that case the spawn auto-resolves to that project id. Required
   * otherwise, and enforced against the role's `projectIds` (if any).
   */
  projectId?: number;
  provider?: string;
  model?: string;
  tier?: 'bootstrap' | 'navigate' | 'full';
  wait?: boolean;
  skills?: string[];
  roleOverride?: string;
}

/**
 * Resolve the effective project id for a spawn given the role's session
 * bindings. Pure function — extracted so the four branches can be tested
 * in isolation without spinning up the orchestrator, sandbox, and DB.
 *
 * Throws on invalid combinations with messages that name the allowed ids,
 * because the tool wraps those errors into the master's `spawn_subordinate_agent`
 * reply so it can autocorrect on retry.
 */
export function resolveSpawnProjectBinding(args: {
  role: string;
  specProjectId: number | undefined;
  boundProjectIds: number[];
}): number {
  const { role, specProjectId, boundProjectIds } = args;
  if (boundProjectIds.length === 0) {
    if (typeof specProjectId !== 'number') {
      throw new Error(
        `Role '${role}' has no project binding — pass project_id explicitly. ` +
          `Use list_company_projects to see available ids.`,
      );
    }
    return specProjectId;
  }
  if (boundProjectIds.length === 1) {
    if (typeof specProjectId !== 'number') return boundProjectIds[0];
    if (!boundProjectIds.includes(specProjectId)) {
      throw new Error(
        `Role '${role}' is bound to project ${boundProjectIds[0]}; ` +
          `project_id=${specProjectId} is not allowed. Omit project_id or delegate to a role bound to that project.`,
      );
    }
    return specProjectId;
  }
  if (typeof specProjectId !== 'number') {
    throw new Error(
      `Role '${role}' is bound to multiple projects [${boundProjectIds.join(', ')}]. ` +
        `Pass project_id to choose one.`,
    );
  }
  if (!boundProjectIds.includes(specProjectId)) {
    throw new Error(
      `Role '${role}' is bound to projects [${boundProjectIds.join(', ')}]; ` +
        `project_id=${specProjectId} is not allowed. Use one of the bound ids.`,
    );
  }
  return specProjectId;
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
  attention: MasterAttention;
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
   *   otherwise (primary project, or service container not yet up)
   *     → fall back to the master binding
   */
  private resolveBindingForProject(
    projectId: number,
  ): import('../types.js').SandboxBinding | null {
    const orchestrator = this.deps.orchestratorRef as {
      getSandboxBinding?: () => import('../types.js').SandboxBinding | null;
      getSandboxServiceBinding?: (
        serviceId: string,
      ) => import('../types.js').SandboxBinding | null;
    };
    const project = this.deps.ctx.projects.find((p) => p.project_id === projectId);
    const label = project?.label ?? null;
    if (label && orchestrator.getSandboxServiceBinding) {
      const svc = orchestrator.getSandboxServiceBinding(label);
      if (svc) return svc;
    }
    return orchestrator.getSandboxBinding ? orchestrator.getSandboxBinding() : null;
  }

  // ─── Spawn ──────────────────────────────────────────────────────

  async spawn(spec: SpawnSubordinateSpec): Promise<{
    agentRunId: number;
    coderSessionId: number;
    status: AgentRunStatus;
  }> {
    const ctx = this.deps.ctx;

    // ── Project binding resolution ────────────────────────────────────
    //
    // Each role can declare `projectIds` in its session config (set via
    // the "Agents per project" UI). The master is meant to think
    // project-first: it sees Project → Roles and picks a role known to
    // work on that project. We enforce the binding here so a wrong
    // project id surfaces as a clear tool-level error instead of silently
    // landing in the wrong workdir. See `resolveSpawnProjectBinding` for
    // the (pure, unit-tested) branch logic.
    const orchestratorForBinding = this.deps.orchestratorRef as unknown as {
      getProjectIdsForRole?: (role: string) => number[];
    };
    const boundProjectIds = orchestratorForBinding.getProjectIdsForRole?.(spec.role) ?? [];
    const projectId = resolveSpawnProjectBinding({
      role: spec.role,
      specProjectId: spec.projectId,
      boundProjectIds,
    });

    if (!ctx.projects.some((p) => p.project_id === projectId)) {
      throw new Error(
        `Project ${projectId} is not linked to company session ${ctx.companySessionId}`,
      );
    }
    // Freeze the resolved id onto spec so the rest of the method stays
    // unchanged (reads spec.projectId for session creation, etc.).
    spec.projectId = projectId;

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

    // Resolve (provider, model) with a priority chain:
    //   1. spec explicit (master passed it to spawn_subordinate_agent)
    //   2. pool default (allowed_models[is_default] || allowed_models[0])
    //      when the caller is silent AND a pool exists
    //   3. hardcoded legacy defaults
    //
    // Then, if a pool is configured, REJECT any (provider, model) not
    // present — this is the enforcement that keeps the master from
    // hallucinating model names when the operator has curated a list.
    const orchestratorForPool = this.deps.orchestratorRef as unknown as {
      getAllowedModels?: () => readonly import('../types.js').AllowedModel[];
      getPoolDefault?: () => import('../types.js').AllowedModel | null;
    };
    const allowedModels = orchestratorForPool.getAllowedModels?.() ?? [];
    const poolDefault = orchestratorForPool.getPoolDefault?.() ?? null;

    let provider = spec.provider;
    let model = spec.model;
    if ((!provider || !model) && poolDefault) {
      provider = provider ?? poolDefault.provider;
      model = model ?? poolDefault.model;
    }
    // Last-resort fallback: inherit from the MASTER's provider/model
    // rather than the hardcoded anthropic/sonnet. This prevents the
    // "master is zai but subordinates spawn anthropic" mismatch when
    // the operator configured neither a template role nor a model pool.
    if (!provider || !model) {
      try {
        const masterRun = ctx.companyStore
          .listAgentRuns(ctx.companySessionId)
          .filter((r) => r.role === 'master')
          .pop();
        if (masterRun) {
          provider = provider ?? masterRun.provider;
          model = model ?? masterRun.model;
        }
      } catch {
        // fall through to the legacy hardcode on any failure — never
        // block a spawn just because the master lookup glitched.
      }
    }
    provider = provider ?? 'anthropic';
    model = model ?? 'claude-sonnet-4-6';

    if (allowedModels.length > 0) {
      const matched = allowedModels.some(
        (a) => a.provider === provider && a.model === model,
      );
      if (!matched) {
        const options = allowedModels
          .map((a) => `${a.provider}/${a.model}${a.is_default ? ' (default)' : ''}`)
          .join(', ');
        throw new Error(
          `Model '${provider}/${model}' is not in this session's allowed_models pool. ` +
            `Retry with one of: ${options}.`,
        );
      }
    }

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

    const subordinateBinding = this.resolveBindingForProject(spec.projectId);
    const subordinateLabel =
      this.deps.ctx.projects.find((p) => p.project_id === spec.projectId)?.label ?? null;
    const subordinateStack = (
      this.deps.orchestratorRef as unknown as {
        getSandboxStackForService?: (serviceId?: string | null) => string | null;
      }
    ).getSandboxStackForService?.(subordinateLabel) ?? 'react-ts';
    const companyContext: CompanyContext = {
      orchestrator: this.deps.orchestratorRef as never,
      companySessionId: ctx.companySessionId,
      agentRole: spec.role,
      agentRunId: agentRun.id,
      allowedProjectIds: [spec.projectId],
      isMaster: false,
      sandbox: subordinateBinding ?? undefined,
    };

    const subordinateBlock = buildSubordinateCompanyBlock({
      role: spec.role,
      projects: [{
        id: spec.projectId,
        name: projectName,
        rootPath: project?.root_path ?? '',
      }],
      builder: subordinateBinding
        ? {
            workdir: subordinateBinding.workdir,
            stack: subordinateStack,
            previewUrl: subordinateBinding.previewUrl,
            peers: (this.deps.orchestratorRef as unknown as {
              listSandboxPeers?: (
                selfServiceId?: string | null,
              ) => Array<{
                serviceId: string;
                stack: string;
                internalUrl: string;
                previewUrl: string;
                isSelf: boolean;
              }>;
            }).listSandboxPeers?.(subordinateBinding.serviceId ?? subordinateLabel) ?? undefined,
          }
        : undefined,
      overridePrompt: spec.roleOverride,
    });

    const handle = await runCoder({
      session: { id: subSession.id },
      userMessage: spec.task,
      maxTurns: 50,
      profile: spec.tier ?? 'navigate',
      companyContext,
      companyPromptBlock: subordinateBlock,
      companyRoleOverride: spec.roleOverride,
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

  async resume(agentRunId: number, message?: string, roleOverride?: string): Promise<{
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

    // Re-read the sandbox binding at resume time, not at spawn time.
    // A subordinate pauses between turns (submit_plan, ask_user, submit_tasks);
    // each resume is a fresh `runCoder` call whose `companyContext.sandbox`
    // must point at the CURRENT container. If we omitted this, runCoder
    // would fall back to LocalFilesystemAdapter and writes would land on
    // the host virtual-project dir instead of `/app` in the sandbox —
    // exactly the bug that made the preview pane keep showing the Vite
    // default template.
    const resumeBinding = this.resolveBindingForProject(projectId);
    const resumeLabel =
      this.deps.ctx.projects.find((p) => p.project_id === projectId)?.label ?? null;
    const resumeStack = (
      this.deps.orchestratorRef as unknown as {
        getSandboxStackForService?: (serviceId?: string | null) => string | null;
      }
    ).getSandboxStackForService?.(resumeLabel) ?? 'react-ts';

    const companyContext: CompanyContext = {
      orchestrator: this.deps.orchestratorRef as never,
      companySessionId: ctx.companySessionId,
      agentRole: agentRun.role,
      agentRunId: agentRun.id,
      allowedProjectIds: projectIds,
      isMaster: false,
      sandbox: resumeBinding ?? undefined,
    };

    const subordinateBlock = buildSubordinateCompanyBlock({
      role: agentRun.role,
      projects: [{
        id: projectId,
        name: project?.name ?? `project-${projectId}`,
        rootPath: project?.root_path ?? '',
      }],
      builder: resumeBinding
        ? {
            workdir: resumeBinding.workdir,
            stack: resumeStack,
            previewUrl: resumeBinding.previewUrl,
            peers: (this.deps.orchestratorRef as unknown as {
              listSandboxPeers?: (
                selfServiceId?: string | null,
              ) => Array<{
                serviceId: string;
                stack: string;
                internalUrl: string;
                previewUrl: string;
                isSelf: boolean;
              }>;
            }).listSandboxPeers?.(resumeBinding.serviceId ?? resumeLabel) ?? undefined,
          }
        : undefined,
      overridePrompt: roleOverride,
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
        companyRoleOverride: roleOverride,
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
    this.deps.attention.signal({ kind: 'finished', agentRunId, role: sub.role });
    return true;
  }

  abortAll(): void {
    for (const sub of this.subordinates.values()) {
      sub.runner.abort();
      this.deps.status.setStatus(sub.agentRunId, 'aborted');
      this.deps.attention.signal({ kind: 'finished', agentRunId: sub.agentRunId, role: sub.role });
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
      this.deps.attention.signal({ kind: 'finished', agentRunId: run.id, role: run.role });
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
    this.runningIds.delete(agentRunId);
    this.deps.attention.signal({ kind: 'finished', agentRunId, role });
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

  private readFinalAssistantText(sessionId: number): string | null {
    try {
      const config = loadConfig();
      const store = new SessionStore(config.dbPath);
      try {
        const loaded = store.loadSessionMessagesTail(sessionId, 3);
        if (!loaded) return null;
        for (let i = loaded.messages.length - 1; i >= 0; i--) {
          const msg = loaded.messages[i];
          if (msg.role !== 'assistant') continue;
          const text = msg.content
            .filter((b): b is { type: 'text'; text: string } =>
              (b as { type?: string }).type === 'text')
            .map((b) => b.text)
            .join('\n')
            .trim();
          if (text) return text;
        }
        return null;
      } finally {
        store.close();
      }
    } catch {
      return null;
    }
  }

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
          this.runningIds.delete(agentRunId);
          this.deps.attention.signal({ kind: 'finished', agentRunId, role });
          this.deps.board.post('system', agentRunId, 'deliverable',
            `@${role}${resumedTag} finished task. Status: **waiting** for next instructions.`);

          const finalText = this.readFinalAssistantText(handle.session.id);
          const finalBlock = finalText
            ? `\n\n--- Final message from @${role} ---\n${finalText}`
            : `\n\n--- Final message from @${role} ---\n(no final assistant text message)`;

          this.deps.master.notify(
            `[SYSTEM] @${role} (agent_run_id=${agentRunId}${resumedTag}) completed and is WAITING. ` +
            `Use forward_to_agent to give it another task (keeps full context), ` +
            `or spawn_subordinate_agent for unrelated work.` +
            finalBlock,
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
