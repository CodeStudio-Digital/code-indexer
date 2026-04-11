/**
 * CompanyOrchestrator — manages a company session with N persistent agent runners.
 *
 * Each subordinate agent is a full `runCoder()` call with its own `CoderSession`,
 * SSE bus, tool registry, and provider. The orchestrator intercepts subordinate
 * `plan_posted` events and routes them to the Master for approval. All events are
 * multiplexed into a single meta-bus for the dashboard to consume.
 */
import { runCoder, type RunCoderOptions, type RunCoderHandle } from '../index.js';
import type { ChatUsage } from '../core/messages.js';
import {
  createBus,
  publish,
  markEnded,
  type CoderRunBus,
} from '../../../apps/http-api/coder-bus.js';
import type { CompanyStore } from '../../../store/company-store.js';
import type { CodeIndexDB } from '../../../store/db.js';
import { SessionStore } from '../sessions/store.js';
import { SkillStore } from '../../../store/skill-store.js';
import { loadConfig } from '../../../utils/config.js';
import type {
  CompanyContext,
  SubordinateHandle,
  AgentRunStatus,
  CompanySessionProject,
} from './types.js';
import { buildMasterCompanyBlock, buildSubordinateCompanyBlock } from './system-prompts.js';

interface PendingPlan {
  agentRunId: number;
  role: string;
  planText: string;
  toolUseId: string;
  resolve: (response: string) => void;
}

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

export interface CompanyOrchestratorOpts {
  companySessionId: number;
  companyStore: CompanyStore;
  db: CodeIndexDB;
}

export class CompanyOrchestrator {
  readonly companySessionId: number;
  readonly metaBus: CoderRunBus;

  /** Exposed for plan-response endpoint. */
  masterHandle: RunCoderHandle | null = null;

  private companyStore: CompanyStore;
  private db: CodeIndexDB;
  private subordinates = new Map<number, SubordinateHandle>();
  private pendingPlans = new Map<number, PendingPlan>();
  private masterAgentRunId: number | null = null;
  private projects: CompanySessionProject[] = [];
  private aborted = false;
  /** Pending master plan — set when master calls submit_plan. */
  private pendingMasterPlan: { resolve: (response: string) => void } | null = null;
  /** Template role configs — stored so spawn_subordinate_agent can use defaults. */
  private roleConfigs: Array<{ role: string; provider: string; model: string; tier: string; skills?: string[] }> = [];
  /** True once master's runner loop has finished (set in .finally of handle.done). */
  private masterEnded = false;
  /** Set when user answers a question/plan — master should auto-continue instead of going idle. */
  private masterShouldContinue = false;
  /** Saved so master can be resumed when a subordinate notifies after master exits. */
  private masterCompanyContext: CompanyContext | null = null;
  private masterPromptBlock: string = '';
  /** IDs of subordinates whose runners are still alive. */
  private runningSubordinateIds = new Set<number>();
  /** Watermark — last board entry ID the master has "seen" (for incremental push). */
  private lastMasterBoardId = 0;

  // Master resurrection concurrency control
  private resumingMasterPromise: Promise<void> | null = null;
  private masterResumeQueue: string[] = [];

  /** Idle timeout — fires markEnded after inactivity when all agents are done. */
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly idleTimeoutMs = 10 * 60 * 1000;

  constructor(opts: CompanyOrchestratorOpts) {
    this.companySessionId = opts.companySessionId;
    this.companyStore = opts.companyStore;
    this.db = opts.db;
    this.metaBus = createBus(new AbortController());
    this.projects = this.companyStore.listCompanySessionProjects(this.companySessionId);
  }

  // ─── Master ────────────────────────────────────────────────────

  async startMaster(opts: {
    userMessage: string;
    provider: string;
    model: string;
    maxTurns?: number;
    signal?: AbortSignal;
    roleConfigs?: Array<{ role: string; provider: string; model: string; tier: string; projectHints?: string[]; skills?: string[] }>;
  }): Promise<RunCoderHandle> {
    if (this.masterHandle) throw new Error('Master already started');

    const primaryProjectId = this.projects[0]?.project_id;
    if (!primaryProjectId) throw new Error('Company session has no linked projects');

    const config = loadConfig();
    const store = new SessionStore(config.dbPath);

    // Create master's coder_session
    const masterSession = store.createSession({
      project_id: primaryProjectId,
      title: `[Company Master] ${this.companySessionId}`,
      provider: opts.provider,
      model: opts.model,
    });

    // Register master agent run
    const masterRun = this.companyStore.createAgentRun({
      company_session_id: this.companySessionId,
      role: 'master',
      coder_session_id: masterSession.id,
      project_ids: this.projects.map((p) => p.project_id),
      provider: opts.provider,
      model: opts.model,
    });
    this.masterAgentRunId = masterRun.id;
    this.roleConfigs = (opts.roleConfigs ?? []) as Array<{ role: string; provider: string; model: string; tier: string; skills?: string[] }>;

    // Update company session
    this.companyStore.setMasterSessionId(this.companySessionId, masterSession.id);
    this.companyStore.updateCompanySessionStatus(this.companySessionId, 'running');

    // Build company context for master
    const companyContext: CompanyContext = {
      orchestrator: this,
      companySessionId: this.companySessionId,
      agentRole: 'master',
      agentRunId: masterRun.id,
      allowedProjectIds: this.projects.map((p) => p.project_id),
      isMaster: true,
    };

    // Enrich projects with labels and names
    const projectInfos = this.projects.map((p) => {
      const proj = this.db.getProject(p.project_id);
      return {
        id: p.project_id,
        name: proj?.name ?? `project-${p.project_id}`,
        rootPath: proj?.root_path ?? '',
        label: p.label ?? undefined,
      };
    });

    const masterPromptBlock = buildMasterCompanyBlock({
      roster: opts.roleConfigs ?? [],
      projects: projectInfos,
    });

    // Save context so we can resume master if a subordinate finishes after master exits
    this.masterCompanyContext = companyContext;
    this.masterPromptBlock = masterPromptBlock;

    // Board: announce master start
    this.postToBoard('system', null, 'message',
      `Master agent started (${opts.provider}/${opts.model}). Analyzing task...`);

    const handle = await runCoder({
      session: { id: masterSession.id },
      userMessage: opts.userMessage,
      maxTurns: opts.maxTurns ?? 100,
      signal: opts.signal,
      planMode: false, // Master acts AUTONOMOUSLY — delegates via spawn_subordinate_agent
      profile: 'full',
      companyContext,
      companyPromptBlock: masterPromptBlock,
    } as RunCoderOptions & { companyPromptBlock: string });

    this.masterHandle = handle;
    this.wireAgentToMetaBus(handle, 'master', masterRun.id);
    this.wireMasterPlanInterception(handle);
    this.wireMasterQuestionInterception(handle);

    // Update status when master finishes — use .finally to GUARANTEE markEnded
    handle.done
      .then(({ reason, error }) => {
        try {
          const detail = error ? ` — ${error}` : '';
          this.companyStore.updateAgentRunStatus(masterRun.id, reason === 'completed' ? 'completed' : 'error', reason !== 'completed' ? `${reason}${detail}` : undefined);
          // Don't mark company session completed yet — subordinates may still be running
        } catch { /* DB errors shouldn't break the stream */ }
        const detail = error ? ` — ${error}` : '';
        this.postToBoard('system', null, 'message',
          `Master finished: ${reason}${detail}`);
      })
      .catch((err) => {
        try {
          this.companyStore.updateAgentRunStatus(masterRun.id, 'error');
        } catch { /* ignore */ }
        this.postToBoard('system', null, 'message',
          `Master error: ${err?.message ?? String(err)}`);
      })
      .finally(() => {
        this.masterEnded = true;
        // Only close the bus if no subordinates are still running
        this.maybeMarkEnded();
      });

    store.close();
    return handle;
  }

  // ─── Resume from cold start (orchestrator recreated from DB) ────

  /**
   * Resume the master from an existing coder session. Used when the user
   * sends a follow-up message AFTER the orchestrator was garbage-collected
   * (server restart, idle timeout, etc.). Reconstructs all internal state
   * from the DB so the master picks up where it left off.
   */
  async resumeExistingMaster(opts: {
    userMessage: string;
    maxTurns?: number;
    roleConfigs?: Array<{ role: string; provider: string; model: string; tier: string; skills?: string[] }>;
  }): Promise<RunCoderHandle> {
    if (this.masterHandle) throw new Error('Master already started');

    // Find the last master agent_run for this company session
    const agentRuns = this.companyStore.listAgentRuns(this.companySessionId);
    const masterRun = agentRuns.filter((r) => r.role === 'master').pop();
    if (!masterRun) throw new Error('No master agent_run found — use startMaster instead');

    this.masterAgentRunId = masterRun.id;
    this.roleConfigs = (opts.roleConfigs ?? []) as Array<{ role: string; provider: string; model: string; tier: string; skills?: string[] }>;

    // Update status
    this.companyStore.updateAgentRunStatus(masterRun.id, 'running');
    this.companyStore.updateCompanySessionStatus(this.companySessionId, 'running');

    // Rebuild company context
    const companyContext: CompanyContext = {
      orchestrator: this,
      companySessionId: this.companySessionId,
      agentRole: 'master',
      agentRunId: masterRun.id,
      allowedProjectIds: this.projects.map((p) => p.project_id),
      isMaster: true,
    };

    const projectInfos = this.projects.map((p) => {
      const proj = this.db.getProject(p.project_id);
      return {
        id: p.project_id,
        name: proj?.name ?? `project-${p.project_id}`,
        rootPath: proj?.root_path ?? '',
        label: p.label ?? undefined,
      };
    });

    const masterPromptBlock = buildMasterCompanyBlock({
      roster: opts.roleConfigs ?? [],
      projects: projectInfos,
    });

    this.masterCompanyContext = companyContext;
    this.masterPromptBlock = masterPromptBlock;

    // Board: announce resume
    this.postToBoard('system', null, 'message',
      `Master resumed from existing session (${masterRun.provider}/${masterRun.model}).`);

    // Resume from existing coder session — keeps full conversation history
    const handle = await runCoder({
      session: { id: masterRun.coder_session_id },
      userMessage: opts.userMessage,
      maxTurns: opts.maxTurns ?? 100,
      planMode: false,
      profile: 'full',
      companyContext,
      companyPromptBlock: masterPromptBlock,
    } as RunCoderOptions & { companyPromptBlock: string });

    this.masterHandle = handle;
    this.wireAgentToMetaBus(handle, 'master', masterRun.id);
    this.wireMasterPlanInterception(handle);
    this.wireMasterQuestionInterception(handle);

    handle.done
      .then(({ reason, error }) => {
        try {
          const detail = error ? ` — ${error}` : '';
          this.companyStore.updateAgentRunStatus(masterRun.id, reason === 'completed' ? 'completed' : 'error', reason !== 'completed' ? `${reason}${detail}` : undefined);
        } catch { /* ignore */ }
        const detail = error ? ` — ${error}` : '';
        this.postToBoard('system', null, 'message',
          `Master finished: ${reason}${detail}`);
      })
      .catch((err) => {
        try {
          this.companyStore.updateAgentRunStatus(masterRun.id, 'error');
        } catch { /* ignore */ }
        this.postToBoard('system', null, 'message',
          `Master error: ${err?.message ?? String(err)}`);
      })
      .finally(() => {
        this.masterEnded = true;
        this.maybeMarkEnded();
      });

    return handle;
  }

  // ─── Master resurrection ────────────────────────────────────────

  /**
   * Notify master about a subordinate event, enriched with board context.
   * Reads all board entries the master hasn't seen yet and appends them to the
   * notification so the master doesn't need to call read_board.
   * If master is still alive → pushUserMessage (immediate).
   * If master already exited → resumeMasterWithMessage (re-run on same session).
   */
  private notifyMasterAboutSubordinate(message: string): void {
    let enrichedMessage = message;
    try {
      const recentBoard = this.companyStore.readBoard(this.companySessionId, {
        sinceId: this.lastMasterBoardId,
        limit: 30,
      });
      if (recentBoard.length > 0) {
        const boardSummary = recentBoard
          .map((e) => `  [@${e.author_role}] (${e.kind}) ${e.content.length > 600 ? e.content.slice(0, 600) + '...' : e.content}`)
          .join('\n');
        enrichedMessage += `\n\n--- Board updates since your last activity (since_id=${this.lastMasterBoardId}) ---\n${boardSummary}`;
        this.lastMasterBoardId = recentBoard[recentBoard.length - 1].id;
      }
    } catch { /* board read failure shouldn't block notification */ }

    if (!this.masterEnded && this.masterHandle?.runner && !this.resumingMasterPromise) {
      this.masterHandle.runner.pushUserMessage(enrichedMessage);
    } else {
      if (this.resumingMasterPromise) {
        // Master is currently spinning up. Queue the message to be pushed
        // as soon as the runner is completely initialized.
        this.masterResumeQueue.push(enrichedMessage);
      } else {
        // Master is gone — resurrect it so it can process the notification
        this.clearIdleTimer();
        void this.resumeMasterWithMessage(enrichedMessage);
      }
    }
  }

  /**
   * Transition to idle when master AND all subordinates are done.
   * Does NOT close the bus — keeps the SSE stream alive so the user can send
   * follow-up messages that resurrect the master. An idle timer will close
   * the bus after idleTimeoutMs of inactivity.
   */
  private maybeMarkEnded(): void {
    if (this.aborted || this.metaBus.ended) return;
    if (!this.masterEnded) return; // master still running — wait
    if (this.runningSubordinateIds.size > 0) return; // subordinates still running

    // Auto-continue after question/plan answer — the master acknowledged the
    // answer but didn't make tool calls, so the runner exited. Resume it so
    // it can proceed with the next orchestration step.
    if (this.masterShouldContinue) {
      this.masterShouldContinue = false;
      void this.resumeMasterWithMessage(
        '[SYSTEM] The human has responded. Continue orchestrating — call the appropriate tools to proceed with the next steps.',
      );
      return;
    }

    // Transition to "paused" — bus stays alive for follow-up messages
    try {
      this.companyStore.updateCompanySessionStatus(this.companySessionId, 'paused');
    } catch { /* ignore */ }
    publish(this.metaBus, 'session_idle', { reason: 'waiting_for_input' });
    this.resetIdleTimer();
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.masterEnded && this.runningSubordinateIds.size === 0 && !this.aborted && !this.metaBus.ended) {
        try { this.companyStore.updateCompanySessionStatus(this.companySessionId, 'completed'); } catch { /* ignore */ }
        markEnded(this.metaBus, 'done', { reason: 'idle_timeout' });
      }
    }, this.idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

  /**
   * Re-run the master coder session with a pending notification message.
   * Called when a subordinate finishes AFTER the master has already exited.
   */
  private async resumeMasterWithMessage(message: string): Promise<void> {
    if (!this.masterHandle || !this.masterCompanyContext || !this.masterAgentRunId) return;
    if (this.aborted || this.metaBus.ended) return;

    if (this.resumingMasterPromise) {
      this.masterResumeQueue.push(message);
      return this.resumingMasterPromise;
    }

    const doResume = async () => {
      try {
        this.companyStore.updateAgentRunStatus(this.masterAgentRunId!, 'running');
      } catch { /* ignore */ }

      this.postToBoard('system', null, 'message',
        'Master reactivated — subordinate reported completion.');

      const masterSessionId = this.masterHandle!.session?.id;
      if (!masterSessionId) {
        console.warn('[company] resumeMasterWithMessage: no master session id');
        return;
      }

      const handle = await runCoder({
        session: { id: masterSessionId },
        userMessage: message,
        maxTurns: 40,
        planMode: false,
        profile: 'full',
        companyContext: this.masterCompanyContext,
        companyPromptBlock: this.masterPromptBlock,
      } as RunCoderOptions & { companyPromptBlock: string });

      this.masterEnded = false; // master is alive again
      this.masterHandle = { ...this.masterHandle!, runner: handle.runner, done: handle.done };
      this.wireAgentToMetaBus(handle, 'master', this.masterAgentRunId!);
      this.wireMasterPlanInterception(handle);
      this.wireMasterQuestionInterception(handle);

      // Flush queue if any other subordinates finished while we were spinning up
      const queued = this.masterResumeQueue.splice(0, this.masterResumeQueue.length);
      for (const msg of queued) {
        handle.runner.pushUserMessage(msg);
      }

      handle.done
        .then(({ reason, error }) => {
          try {
            const detail = error ? ` — ${error}` : '';
            this.companyStore.updateAgentRunStatus(
              this.masterAgentRunId!,
              reason === 'completed' ? 'completed' : 'error',
              reason !== 'completed' ? `${reason}${detail}` : undefined,
            );
          } catch { /* ignore */ }
          const detail = error ? ` — ${error}` : '';
          this.postToBoard('system', null, 'message', `Master finished: ${reason}${detail}`);
        })
        .catch((err) => {
          this.postToBoard('system', null, 'message',
            `Master error: ${err?.message ?? String(err)}`);
        })
        .finally(() => {
          this.masterEnded = true;
          this.maybeMarkEnded();
        });
    };

    this.resumingMasterPromise = doResume().finally(() => {
      this.resumingMasterPromise = null;
    });
    return this.resumingMasterPromise;
  }

  // ─── Master plan interception (for human approval) ─────────────

  private wireMasterPlanInterception(handle: RunCoderHandle): void {
    handle.runner.on('plan_posted', (block: { plan: string }) => {
      // Publish to meta-bus so dashboard can show the plan approval card
      publish(this.metaBus, 'master_plan_posted', {
        plan: block.plan,
      });
      this.postToBoard('master', this.masterAgentRunId, 'question',
        `[Master submitted plan for human review]`);
    });
  }

  /** Called by the HTTP plan-response endpoint when human approves/rejects. */
  respondToMasterPlan(approved: boolean, feedback?: string): boolean {
    if (!this.masterHandle) return false;
    const response = JSON.stringify({ approved, feedback: feedback ?? '' });
    const resolved = this.masterHandle.runner.provideUserInput(response);
    if (resolved) {
      this.masterShouldContinue = true;
      this.postToBoard('human', null, 'decision',
        `Plan ${approved ? 'APPROVED' : 'REJECTED'}${feedback ? `: ${feedback}` : ''}`);
    }
    return resolved;
  }

  // ─── Master question interception (for human answers) ──────────

  private wireMasterQuestionInterception(handle: RunCoderHandle): void {
    handle.runner.on('question_posted', (block: {
      id: string;
      question: string;
      options?: Array<{ label: string; value: string }>;
      allowFreeform?: boolean;
    }) => {
      this.postToBoard('master', this.masterAgentRunId, 'question',
        `[Master asks human]: ${block.question}`);

      publish(this.metaBus, 'master_question_posted', {
        questionId: block.id,
        question: block.question,
        options: block.options,
        allowFreeform: block.allowFreeform,
      });
    });
  }

  /** Called by the HTTP answer endpoint when human answers a master question. */
  respondToMasterQuestion(answer: string): boolean {
    if (!this.masterHandle) return false;
    const response = JSON.stringify({ answer });
    const resolved = this.masterHandle.runner.provideUserInput(response);
    if (resolved) {
      this.masterShouldContinue = true;
      this.postToBoard('human', null, 'decision', `Human answered: ${answer}`);
    }
    return resolved;
  }

  // ─── Subordinate spawning ──────────────────────────────────────

  async spawnSubordinate(spec: SpawnSubordinateSpec): Promise<{
    agentRunId: number;
    coderSessionId: number;
    status: AgentRunStatus;
  }> {
    if (!this.projects.some((p) => p.project_id === spec.projectId)) {
      throw new Error(
        `Project ${spec.projectId} is not linked to company session ${this.companySessionId}`,
      );
    }

    const config = loadConfig();
    const store = new SessionStore(config.dbPath);

    const provider = spec.provider ?? 'anthropic';
    const model = spec.model ?? 'claude-sonnet-4-6';
    const project = this.db.getProject(spec.projectId);
    const projectName = project?.name ?? `project-${spec.projectId}`;

    // Board: announce subordinate spawn
    this.postToBoard('system', null, 'message',
      `Spawned @${spec.role} agent (project: ${projectName}, ${provider}/${model})`);

    // Create subordinate's coder_session
    const subSession = store.createSession({
      project_id: spec.projectId,
      title: `[Company ${spec.role}] ${this.companySessionId}`,
      provider,
      model,
    });

    // Inherit master's disabled tool config so subordinates respect the same
    // tool restrictions the user configured for this company session.
    if (this.masterHandle) {
      try {
        store.copyToolConfig(this.masterHandle.session.id, subSession.id);
      } catch (e) {
        console.warn(`[company] Failed to copy tool config to ${spec.role}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Configure skills
    if (spec.skills && spec.skills.length > 0) {
      try {
        const skillStore = new SkillStore(config.dbPath);
        const allSkills = skillStore.resolveActiveSkills(subSession.id, spec.projectId);
        for (const skill of allSkills) {
          const shouldEnable = spec.skills.includes(skill.id);
          skillStore.setSessionSkillEnabled(subSession.id, skill.id, shouldEnable);
        }
        skillStore.close();
      } catch (e) {
        console.warn(`[company] Failed to configure skills for ${spec.role}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Register agent run
    const agentRun = this.companyStore.createAgentRun({
      company_session_id: this.companySessionId,
      role: spec.role,
      coder_session_id: subSession.id,
      project_ids: [spec.projectId],
      provider,
      model,
    });

    // Build company context
    const companyContext: CompanyContext = {
      orchestrator: this,
      companySessionId: this.companySessionId,
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

    // Start the subordinate runner
    const handle = await runCoder({
      session: { id: subSession.id },
      userMessage: spec.task,
      maxTurns: 50,
      profile: spec.tier ?? 'navigate',
      companyContext,
      companyPromptBlock: subordinateBlock,
    } as RunCoderOptions & { companyPromptBlock: string });

    // Wire plan interception for subordinate
    this.wireSubordinatePlanInterception(handle, agentRun.id, spec.role);
    // Wire SSE to meta-bus
    this.wireAgentToMetaBus(handle, spec.role, agentRun.id);

    this.companyStore.updateAgentRunStatus(agentRun.id, 'running');
    this.runningSubordinateIds.add(agentRun.id);

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

    // Update status when subordinate finishes + push notification to Master.
    // Completed subordinates go to 'waiting' (not 'completed') so they can be reused.
    handle.done
      .then(({ reason, error }) => {
        if (reason === 'completed') {
          // Keep subordinate alive as 'waiting' — Master can forward_to_agent to reuse
          try { this.companyStore.updateAgentRunStatus(agentRun.id, 'waiting', 'Task done. Ready for next task.'); } catch { /* ignore */ }
          this.postToBoard('system', agentRun.id, 'deliverable',
            `@${spec.role} finished task. Status: **waiting** for next instructions.`);
          this.notifyMasterAboutSubordinate(
            `[SYSTEM] @${spec.role} (agent_run_id=${agentRun.id}) completed and is WAITING. ` +
            `Use forward_to_agent to give it another task (keeps full context), ` +
            `or spawn_subordinate_agent for unrelated work.`,
          );
        } else {
          const detail = error ? ` — ${error}` : '';
          try { this.companyStore.updateAgentRunStatus(agentRun.id, 'error', `Ended: ${reason}${detail}`); } catch { /* ignore */ }
          this.postToBoard('system', agentRun.id, 'message', `@${spec.role} ended: ${reason}${detail}`);
          this.notifyMasterAboutSubordinate(
            `[SYSTEM] @${spec.role} (agent_run_id=${agentRun.id}) ended with: ${reason}${detail}. ` +
            `Use resume_subordinate to retry.`,
          );
        }
      })
      .catch((err) => {
        const errorDetail = err instanceof Error ? err.message : String(err);
        try { this.companyStore.updateAgentRunStatus(agentRun.id, 'error', errorDetail); } catch { /* ignore */ }
        this.postToBoard('system', agentRun.id, 'message', `@${spec.role} FAILED: ${errorDetail}`);
        this.notifyMasterAboutSubordinate(
          `[SYSTEM] @${spec.role} (agent_run_id=${agentRun.id}) FAILED: ${errorDetail}. ` +
          `Use resume_subordinate to retry or spawn_subordinate_agent for fresh start.`,
        );
      })
      .finally(() => {
        // Remove from running set and check if we can close the bus
        this.runningSubordinateIds.delete(agentRun.id);
        this.maybeMarkEnded();
      });

    store.close();

    if (spec.wait) {
      await handle.done;
    }

    return {
      agentRunId: agentRun.id,
      coderSessionId: subSession.id,
      status: 'running',
    };
  }

  // ─── Subordinate plan interception ─────────────────────────────

  private wireSubordinatePlanInterception(
    handle: RunCoderHandle,
    agentRunId: number,
    role: string,
  ): void {
    handle.runner.on('plan_posted', (block: { plan: string; toolUseId?: string }) => {
      this.companyStore.updateAgentRunStatus(agentRunId, 'waiting_plan');

      this.postToBoard(role, agentRunId, 'question',
        `[@master] ${role} submitted plan for review:\n\n${block.plan}`);

      publish(this.metaBus, 'subordinate_plan_posted', {
        agentRunId,
        role,
        plan: block.plan,
      });

      this.pendingPlans.set(agentRunId, {
        agentRunId,
        role,
        planText: block.plan,
        toolUseId: block.toolUseId ?? '',
        resolve: (response: string) => {
          handle.runner.provideUserInput(response);
          this.companyStore.updateAgentRunStatus(agentRunId, 'running');
        },
      });
    });
  }

  // ─── Resume failed subordinate ──────────────────────────────────

  async resumeSubordinate(agentRunId: number, message?: string): Promise<{
    agentRunId: number;
    coderSessionId: number;
    status: AgentRunStatus;
  }> {
    // Look up the agent run from DB
    const agentRun = this.companyStore.getAgentRun(agentRunId);
    if (!agentRun) throw new Error(`Agent run ${agentRunId} not found`);
    if (agentRun.company_session_id !== this.companySessionId) {
      throw new Error(`Agent run ${agentRunId} does not belong to this company session`);
    }
    const resumableStatuses = ['error', 'aborted', 'waiting', 'completed'];
    if (!resumableStatuses.includes(agentRun.status)) {
      throw new Error(`Agent run ${agentRunId} status is ${agentRun.status}, not resumable (need: ${resumableStatuses.join('/')})`);
    }

    const config = loadConfig();
    const store = new SessionStore(config.dbPath);
    const projectIds: number[] = JSON.parse(agentRun.project_ids_json);
    const projectId = projectIds[0];
    const project = this.db.getProject(projectId);

    const companyContext: CompanyContext = {
      orchestrator: this,
      companySessionId: this.companySessionId,
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

    this.postToBoard('system', agentRun.id, 'message',
      `Resuming @${agentRun.role} agent...`);

    // Resume using the EXISTING session — keeps full history.
    // Don't specify profile — runCoder defaults to 'full' for sessions with
    // existing history, which is correct (avoids tool mismatches with the
    // original session's tool set).
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
      const errorDetail = e instanceof Error ? e.message : String(e);
      try { this.companyStore.updateAgentRunStatus(agentRun.id, 'error', `Resume failed: ${errorDetail}`); } catch { /* ignore */ }
      this.postToBoard('system', agentRun.id, 'message',
        `@${agentRun.role} resume FAILED: ${errorDetail}`);
      this.notifyMasterAboutSubordinate(
        `[SYSTEM] @${agentRun.role} (agent_run_id=${agentRun.id}) resume FAILED: ${errorDetail}. ` +
        `Use spawn_subordinate_agent for a fresh start.`,
      );
      store.close();
      throw e;
    }

    this.wireSubordinatePlanInterception(handle, agentRun.id, agentRun.role);
    this.wireAgentToMetaBus(handle, agentRun.role, agentRun.id);

    this.companyStore.updateAgentRunStatus(agentRun.id, 'running');
    this.runningSubordinateIds.add(agentRun.id);

    const subordinateHandle: SubordinateHandle = {
      agentRunId: agentRun.id,
      role: agentRun.role,
      projectIds: projectIds,
      session: store.getSession(agentRun.coder_session_id)!,
      runner: handle.runner,
      bus: createBus(new AbortController()),
      done: handle.done,
    };
    this.subordinates.set(agentRun.id, subordinateHandle);

    // Completion handler — same pattern as spawnSubordinate:
    // uses notifyMasterAboutSubordinate (handles master alive OR dead),
    // and includes .finally() for cleanup.
    handle.done
      .then(({ reason, error }) => {
        if (reason === 'completed') {
          try { this.companyStore.updateAgentRunStatus(agentRun.id, 'waiting', 'Task done. Ready for next task.'); } catch { /* ignore */ }
          this.postToBoard('system', agentRun.id, 'deliverable',
            `@${agentRun.role} (resumed) finished task. Status: **waiting** for next instructions.`);
          this.notifyMasterAboutSubordinate(
            `[SYSTEM] @${agentRun.role} (agent_run_id=${agentRun.id}, resumed) completed and is WAITING. ` +
            `Use forward_to_agent to give it another task (keeps full context).`,
          );
        } else {
          const detail = error ? ` — ${error}` : '';
          try { this.companyStore.updateAgentRunStatus(agentRun.id, 'error', `Ended: ${reason}${detail}`); } catch { /* ignore */ }
          this.postToBoard('system', agentRun.id, 'message', `@${agentRun.role} (resumed) ended: ${reason}${detail}`);
          this.notifyMasterAboutSubordinate(
            `[SYSTEM] @${agentRun.role} (agent_run_id=${agentRun.id}, resumed) ended with: ${reason}${detail}. ` +
            `Use resume_subordinate to retry.`,
          );
        }
      })
      .catch((err) => {
        const errorDetail = err instanceof Error ? err.message : String(err);
        try { this.companyStore.updateAgentRunStatus(agentRun.id, 'error', errorDetail); } catch { /* ignore */ }
        this.postToBoard('system', agentRun.id, 'message',
          `@${agentRun.role} (resumed) FAILED: ${errorDetail}`);
        this.notifyMasterAboutSubordinate(
          `[SYSTEM] @${agentRun.role} (agent_run_id=${agentRun.id}, resumed) FAILED: ${errorDetail}. ` +
          `Use resume_subordinate to retry or spawn_subordinate_agent for fresh start.`,
        );
      })
      .finally(() => {
        this.runningSubordinateIds.delete(agentRun.id);
        this.maybeMarkEnded();
      });

    store.close();
    return { agentRunId: agentRun.id, coderSessionId: agentRun.coder_session_id, status: 'running' };
  }

  resolveSubordinatePlan(
    agentRunId: number,
    approved: boolean,
    feedback?: string,
  ): boolean {
    const pending = this.pendingPlans.get(agentRunId);
    if (!pending) return false;

    const response = JSON.stringify({ approved, feedback: feedback ?? '' });
    pending.resolve(response);
    this.pendingPlans.delete(agentRunId);

    this.postToBoard('master', this.masterAgentRunId, 'decision',
      `[@${pending.role}] Plan ${approved ? 'APPROVED' : 'REJECTED'}${feedback ? `: ${feedback}` : ''}`);

    return true;
  }

  // ─── Abort ─────────────────────────────────────────────────────

  abortSubordinate(agentRunId: number): boolean {
    const sub = this.subordinates.get(agentRunId);
    if (!sub) return false;
    sub.runner.abort();
    this.companyStore.updateAgentRunStatus(agentRunId, 'aborted');
    return true;
  }

  abortAll(): void {
    this.aborted = true;
    this.clearIdleTimer();
    for (const sub of this.subordinates.values()) {
      sub.runner.abort();
      try { this.companyStore.updateAgentRunStatus(sub.agentRunId, 'aborted'); } catch { /* ignore */ }
    }
    if (this.masterHandle) {
      this.masterHandle.runner.abort();
      if (this.masterAgentRunId) {
        try { this.companyStore.updateAgentRunStatus(this.masterAgentRunId, 'aborted'); } catch { /* ignore */ }
      }
    }
    try { this.companyStore.updateCompanySessionStatus(this.companySessionId, 'error'); } catch { /* ignore */ }
    if (!this.metaBus.ended) {
      markEnded(this.metaBus, 'done', { reason: 'aborted' });
    }
  }

  // ─── Board ─────────────────────────────────────────────────────

  postToBoard(
    authorRole: string,
    agentRunId: number | null,
    kind: 'message' | 'decision' | 'question' | 'deliverable' | 'handoff',
    content: string,
    mentions?: string[],
  ): void {
    const extractedMentions = mentions ?? [];
    if (!mentions) {
      const re = /@(\w+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content))) extractedMentions.push(m[1]);
    }

    const entry = this.companyStore.postToBoard(
      this.companySessionId, authorRole, agentRunId, kind, content, extractedMentions,
    );

    // Advance watermark — master "sees" its own posts and system announcements
    if (authorRole === 'master' || authorRole === 'system') {
      this.lastMasterBoardId = Math.max(this.lastMasterBoardId, entry.id);
    }

    publish(this.metaBus, 'board_entry', {
      id: entry.id,
      author_role: entry.author_role,
      agent_run_id: entry.agent_run_id,
      kind: entry.kind,
      content: entry.content,
      mentions: entry.mentions,
      created_at: entry.created_at,
    });
  }

  readBoard(opts?: { sinceId?: number; limit?: number; mentionsRole?: string }) {
    const entries = this.companyStore.readBoard(this.companySessionId, {
      sinceId: opts?.sinceId,
      limit: opts?.limit ?? 50,
    });
    if (opts?.mentionsRole) {
      return entries.filter(
        (e) => e.mentions.includes(opts.mentionsRole!) || e.mentions.includes('all'),
      );
    }
    return entries;
  }

  // ─── Queries ───────────────────────────────────────────────────

  listSubordinates(): Array<{
    agentRunId: number;
    role: string;
    status: AgentRunStatus;
    projectIds: number[];
    provider: string;
    model: string;
  }> {
    const runs = this.companyStore.listAgentRuns(this.companySessionId);
    return runs
      .filter((r) => r.role !== 'master')
      .map((r) => ({
        agentRunId: r.id,
        role: r.role,
        status: r.status as AgentRunStatus,
        projectIds: JSON.parse(r.project_ids_json),
        provider: r.provider,
        model: r.model,
      }));
  }

  /** True while at least one subordinate runner is still active. */
  hasRunningSubordinates(): boolean {
    return this.runningSubordinateIds.size > 0;
  }

  isSubordinateRunning(agentRunId: number): boolean {
    return this.runningSubordinateIds.has(agentRunId);
  }

  listProjects() {
    return this.projects.map((p) => {
      const proj = this.db.getProject(p.project_id);
      return {
        id: p.project_id,
        name: proj?.name ?? `project-${p.project_id}`,
        rootPath: proj?.root_path ?? '',
        label: p.label,
      };
    });
  }

  /** Set agent status + publish to metaBus for dashboard. */
  setAgentStatus(agentRunId: number, role: string, status: string, message: string): void {
    try {
      this.companyStore.updateAgentRunStatus(agentRunId, status as AgentRunStatus, message);
    } catch { /* ignore */ }
    publish(this.metaBus, 'agent_status', {
      agentRunId,
      role,
      status,
      message,
    });
    this.postToBoard(role, agentRunId, 'message',
      `Status: **${status}**${message ? ` — ${message}` : ''}`);
  }

  /**
   * Re-activate a waiting, completed, errored, or aborted subordinate.
   * Creates a new runCoder call with the existing session, preserving full history.
   */
  async reactivateSubordinate(agentRunId: number, message: string): Promise<boolean> {
    const agentRun = this.companyStore.getAgentRun(agentRunId);
    if (!agentRun) return false;
    const resumableStatuses = ['error', 'aborted', 'waiting', 'completed'];
    if (!resumableStatuses.includes(agentRun.status)) {
      console.warn(`[company] Cannot reactivate ${agentRun.role}: status is ${agentRun.status}`);
      return false;
    }

    // Use the same resumeSubordinate mechanism
    try {
      await this.resumeSubordinate(agentRunId, message);
      return true;
    } catch (e) {
      console.warn(`[company] Failed to reactivate ${agentRun.role}: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  /** Send a follow-up message from the human to the master agent. */
  sendMessageToMaster(message: string): boolean {
    this.postToBoard('human', null, 'message', message);
    this.clearIdleTimer();

    if (!this.masterEnded && this.masterHandle?.runner) {
      this.masterHandle.runner.pushUserMessage(message);
      return true;
    }
    // Master ended — resurrect with the message
    try { this.companyStore.updateCompanySessionStatus(this.companySessionId, 'running'); } catch { /* ignore */ }
    void this.resumeMasterWithMessage(message);
    return true;
  }

  /** Get template defaults for a role (provider, model, tier, skills). */
  getRoleDefaults(role: string): { provider?: string; model?: string; tier?: string; skills?: string[] } | null {
    const cfg = this.roleConfigs.find((r) => r.role === role);
    return cfg ? { provider: cfg.provider, model: cfg.model, tier: cfg.tier, skills: cfg.skills } : null;
  }

  hasPendingPlan(agentRunId: number): boolean {
    return this.pendingPlans.has(agentRunId);
  }

  getSubordinate(agentRunId: number): SubordinateHandle | undefined {
    return this.subordinates.get(agentRunId);
  }

  /** Get the current DB status of a subordinate (not the in-memory handle state). */
  getSubordinateStatus(agentRunId: number): AgentRunStatus | null {
    const run = this.companyStore.getAgentRun(agentRunId);
    return run ? run.status as AgentRunStatus : null;
  }

  // ─── Meta-bus wiring ───────────────────────────────────────────

  private wireAgentToMetaBus(
    handle: RunCoderHandle,
    role: string,
    agentRunId: number,
  ): void {
    const events = [
      'text_delta', 'tool_call_start', 'tool_call_result',
      'message_complete', 'plan_posted', 'question_posted',
      'tasks_posted', 'task_started', 'task_finished',
      'todos_updated', 'provider_swapped',
      'agents_group_start', 'agent_progress', 'agents_group_end',
      'auto_continue', 'context_status',
    ];

    for (const evt of events) {
      (handle.runner as import('node:events').EventEmitter).on(evt, (...args: unknown[]) => {
        publish(this.metaBus, 'agent_event', {
          agent: role,
          agentRunId,
          event: evt,
          data: args.length === 1 ? args[0] : args,
        });
      });
    }

    handle.runner.on('done', (reason: string, error?: Error) => {
      publish(this.metaBus, 'agent_event', {
        agent: role,
        agentRunId,
        event: 'done',
        data: { reason, error: error?.message },
      });
    });
  }
}
