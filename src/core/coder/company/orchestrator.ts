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
      companyPromptBlock: buildMasterCompanyBlock({
        roster: opts.roleConfigs ?? [],
        projects: projectInfos,
      }),
    } as RunCoderOptions & { companyPromptBlock: string });

    this.masterHandle = handle;
    this.wireAgentToMetaBus(handle, 'master', masterRun.id);
    this.wireMasterPlanInterception(handle);

    // Update status when master finishes — use .finally to GUARANTEE markEnded
    handle.done
      .then(({ reason }) => {
        try {
          this.companyStore.updateAgentRunStatus(masterRun.id, reason === 'completed' ? 'completed' : 'error');
          this.companyStore.updateCompanySessionStatus(this.companySessionId, 'completed');
        } catch { /* DB errors shouldn't break the stream */ }
        this.postToBoard('system', null, 'message',
          `Master finished: ${reason}`);
      })
      .catch((err) => {
        try {
          this.companyStore.updateAgentRunStatus(masterRun.id, 'error');
          this.companyStore.updateCompanySessionStatus(this.companySessionId, 'error');
        } catch { /* ignore */ }
        this.postToBoard('system', null, 'message',
          `Master error: ${err?.message ?? String(err)}`);
      })
      .finally(() => {
        if (!this.aborted && !this.metaBus.ended) {
          markEnded(this.metaBus, 'done', { reason: 'completed' });
        }
      });

    store.close();
    return handle;
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
      this.postToBoard('human', null, 'decision',
        `Plan ${approved ? 'APPROVED' : 'REJECTED'}${feedback ? `: ${feedback}` : ''}`);
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

    // Update status when subordinate finishes — .finally guarantees cleanup
    handle.done
      .then(({ reason }) => {
        const finalStatus: AgentRunStatus = reason === 'completed' ? 'completed' : 'error';
        try { this.companyStore.updateAgentRunStatus(agentRun.id, finalStatus); } catch { /* ignore */ }
        this.postToBoard('system', null, 'message',
          `@${spec.role} finished: ${reason}`);
      })
      .catch(() => {
        try { this.companyStore.updateAgentRunStatus(agentRun.id, 'error'); } catch { /* ignore */ }
        this.postToBoard('system', null, 'message',
          `@${spec.role} encountered an error`);
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
