/**
 * CompanyOrchestrator — facade that composes the focused services owning the
 * domain logic. Service wiring lives in `./orchestrator/wire-services.ts`;
 * sandbox helpers in `./orchestrator/sandbox-helpers.ts`; the watermark-aware
 * board read in `./orchestrator/board-helpers.ts`. This class is thin: it
 * keeps `metaBus`, exposes service handles, and delegates the public API so
 * tools / HTTP routes / CompanyContext consumers keep working unchanged.
 */
import type { RunCoderHandle, MasterStartResult } from '@mcp/code-agent/index.js';
import type { CoderRunBus } from '@apps/http-api/coder-bus.js';
import type { CompanyStore } from '@mcp/store/company-store.js';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type {
  AgentRunStatus,
  BoardEntry,
  KanbanCard,
  KanbanCardAgent,
  KanbanCardDependency,
  KanbanCardFull,
  KanbanChecklistItem,
  KanbanColumn,
  KanbanComment,
  KanbanTag,
  SubordinateHandle,
} from '@mcp/company/types.js';
import type {
  AgentInboxMessage,
  InboxStatus,
  Pipeline,
  PipelineExecution,
  PipelineExecutionStatus,
  PipelineGraph,
  PipelineNodeExecution,
  SandboxBinding,
} from '@mcp/company/types.js';

import type { SessionContext } from './services/SessionContext.js';
import type { MetaBusPublisher } from './services/MetaBusPublisher.js';
import type { KanbanService } from './services/KanbanService.js';
import type { BoardBridge } from './services/BoardBridge.js';
import type { AgentStatusUpdater } from './services/AgentStatusUpdater.js';
import type { HumanInTheLoop } from './services/HumanInTheLoop.js';
import type { IdleController } from './services/IdleController.js';
import type { SubordinateLifecycle, SpawnSubordinateSpec } from './services/SubordinateLifecycle.js';
import type { MasterLifecycle, RoleConfig } from './services/MasterLifecycle.js';
import type { MasterAttention, AttentionListener } from './services/MasterAttention.js';
import type { SandboxService } from './services/SandboxService.js';
import type { PipelineService, PipelineValidationResult } from './services/PipelineService.js';
import type { PipelineExecutor } from './services/PipelineExecutor.js';
import type { InboxQueue, SendArgs as InboxSendArgs, SendResult as InboxSendResult } from './services/InboxQueue.js';
import type { MasterInboxRouter } from './services/MasterInboxRouter.js';
import type { RuntimeReconciler } from './services/RuntimeReconciler.js';
import type { CompanyDriveStore } from './services/CompanyDriveStore.js';
import type { CompanyEventBus } from './services/CompanyEventBus.js';
import type { IdleWatchdog } from './services/IdleWatchdog.js';

import { wireServices } from './orchestrator/wire-services.js';
import {
  getSandboxBinding,
  getSandboxServiceBinding,
  listSandboxPeers,
  provisionSandboxIfNeeded,
  type SandboxPeer,
} from './orchestrator/sandbox-helpers.js';
import { readBoardWithWatermarks, type ReadBoardOptions } from './orchestrator/board-helpers.js';
import { consolidateBoardToMemory } from './services/memory/board-consolidator.js';

export type { SpawnSubordinateSpec };

export interface CompanyOrchestratorOpts {
  companySessionId: number;
  companyStore: CompanyStore;
  db: CodeIndexDB;
}

export class CompanyOrchestrator {
  readonly companySessionId: number;
  /**
   * When non-null, this orchestrator is a sub-session ("front tab") of the
   * parent. Sandbox / projects / kanban / pipelines / services / env are
   * read from the parent so all sub-sessions share the same project
   * context. Board / agent_runs / master_prompts / inbox stay isolated.
   */
  readonly parentSessionId: number | null;
  readonly metaBus: CoderRunBus;
  /** Builder-mode sandbox bridge. Dormant when the session has no `builder` config. */
  readonly sandboxService: SandboxService;
  /**
   * Internal pub/sub that decouples Master/Subordinate from `IdleController`.
   * Exposed so the AgentSupervisor can subscribe inside a company-worker.
   */
  readonly eventBus: CompanyEventBus;
  /** Company-scoped shared file drive. */
  readonly driveStore: CompanyDriveStore;

  private readonly ctx: SessionContext;
  private readonly publisher: MetaBusPublisher;
  private readonly kanban: KanbanService;
  private readonly board: BoardBridge;
  private readonly status: AgentStatusUpdater;
  private readonly attention: MasterAttention;
  private readonly humanInLoop: HumanInTheLoop;
  private readonly idle: IdleController;
  private readonly watchdog: IdleWatchdog;
  private readonly subordinates: SubordinateLifecycle;
  private readonly master: MasterLifecycle;
  private readonly pipelines: PipelineService;
  private readonly pipelineExecutor: PipelineExecutor;
  private readonly inbox: InboxQueue;
  private readonly masterInbox: MasterInboxRouter;
  private readonly reconciler: RuntimeReconciler;

  constructor(opts: CompanyOrchestratorOpts) {
    this.companySessionId = opts.companySessionId;
    const w = wireServices({ ...opts, orchestratorRef: this });
    this.metaBus = w.metaBus;
    this.parentSessionId = w.parentSessionId;
    this.ctx = w.ctx;
    this.publisher = w.publisher;
    this.kanban = w.kanban;
    this.board = w.board;
    this.status = w.status;
    this.attention = w.attention;
    this.sandboxService = w.sandboxService;
    this.eventBus = w.eventBus;
    this.driveStore = w.driveStore;
    this.humanInLoop = w.humanInLoop;
    this.idle = w.idle;
    this.watchdog = w.watchdog;
    this.subordinates = w.subordinates;
    this.master = w.master;
    this.pipelines = w.pipelines;
    this.pipelineExecutor = w.pipelineExecutor;
    this.inbox = w.inbox;
    this.masterInbox = w.masterInbox;
    this.reconciler = w.reconciler;
  }

  /**
   * Effective session id for SHARED resources (kanban, pipelines, env,
   * services, drive, docs, databases, design-system). Sub-sessions resolve
   * to the parent's id so all tabs see the same project-wide artefacts.
   */
  get effectiveSessionId(): number { return this.ctx.effectiveSessionId; }
  get isMasterAlive(): boolean { return this.master?.isAlive ?? false; }
  get hasMasterStarted(): boolean { return !!this.master?.handle; }
  get masterEndedAt(): string | null { return this.master?.endedAt ?? null; }
  /** @deprecated prefer `getMasterAgentRunId()`. */
  get masterHandle(): RunCoderHandle | null { return this.master.handle; }
  getMasterAgentRunId(): number | null { return this.master.agentRunId; }

  /**
   * POJO master-status snapshot for the MAIN thread. The worker-backed
   * orchestrator proxy can't read `isMasterAlive`/`masterEndedAt`
   * synchronously — a property GET returns a nested proxy, not a value, so
   * `JSON.stringify`-ing them (e.g. in a route's `c.json`) dispatches a bogus
   * `.toJSON` RPC. Main-side callers fetch these through this awaited method
   * instead (the apply-trap dispatches a real RPC; the getters resolve to
   * actual values here inside the worker).
   */
  async getMasterStatus(): Promise<{ alive: boolean; endedAt: string | null }> {
    return { alive: this.isMasterAlive, endedAt: this.masterEndedAt };
  }

  /** Dashboard "Acordar Master" entry — idempotent inbox delivery. */
  async tryDeliverMasterInboxNow(): Promise<void> {
    if (!this.masterInbox) return;
    await this.masterInbox.tryDeliverNow();
  }

  // ─── Master lifecycle ──────────────────────────────────────────
  async startMaster(opts: {
    userMessage: string; provider: string; model: string; maxTurns?: number; signal?: AbortSignal;
    roleConfigs?: RoleConfig[]; attachments?: import('@mcp/code-agent/index.js').CoderAttachment[];
    thinking?: boolean;
    /**
     * When true the master prompt routes non-trivial work through the
     * built-in SDD pipeline. Threaded into `MasterPromptContext.sddMode`.
     */
    sddMode?: boolean;
  }): Promise<MasterStartResult> {
    // The lifecycle returns the ack as soon as the run is registered; the
    // sandbox provision + runCoder boot run in the background (so this RPC
    // stays well under its 60s deadline even on a cold container rebuild).
    return this.master.start(opts);
  }

  async resumeExistingMaster(opts: {
    userMessage: string; maxTurns?: number; roleConfigs?: RoleConfig[];
    attachments?: import('@mcp/code-agent/index.js').CoderAttachment[]; thinking?: boolean;
  }): Promise<MasterStartResult> {
    return this.master.resumeExisting(opts);
  }

  notifyMasterAboutSubordinate(message: string): void { this.master.notify(message); }
  /** Force the master's runner to release a pending `waitForUserInput`. */
  interruptMasterWait(info?: { kind?: 'plan' | 'question' | 'tasks'; agentRunId?: number; role?: string }): boolean {
    return this.master.handle?.runner.interruptWait(info) ?? false;
  }
  respondToMasterPlan(approved: boolean, feedback?: string, promptId?: number) { return this.humanInLoop.respondToMasterPlan(approved, feedback, promptId); }
  respondToMasterQuestion(answer: string, promptId?: number) { return this.humanInLoop.respondToMasterQuestion(answer, promptId); }
  async swapMasterProvider(providerName: string, model?: string): Promise<{ provider: string; model: string }> { return this.master.swapProvider(providerName, model); }
  updateRoleConfigs(roleConfigs: RoleConfig[]): void { this.master.updateRoleConfigs(roleConfigs); }

  /**
   * Apply a partial config patch to a running session and persist it.
   * `role_assignments` is the authoritative update path for running agents;
   * skills / allowed_models don't require a restart (consulted lazily by
   * subordinate spawns and the master's rendered roster).
   */
  applyConfigPatch(patch: {
    role_assignments?: RoleConfig[];
    skills?: Record<string, string[]>;
    allowed_models?: import('@mcp/company/types.js').AllowedModel[];
  }): void {
    const sessionId = this.ctx.companySessionId;
    const row = this.ctx.companyStore.getCompanySession(sessionId);
    if (!row) throw new Error(`Company session ${sessionId} not found`);
    let cfg: Record<string, unknown> = {};
    try { cfg = JSON.parse(row.config_json || '{}'); } catch { cfg = {}; }
    if (patch.role_assignments) cfg.role_assignments = patch.role_assignments;
    if (patch.skills) cfg.skills = patch.skills;
    if (patch.allowed_models) cfg.allowed_models = patch.allowed_models;
    this.ctx.companyStore.updateCompanySessionConfig(sessionId, JSON.stringify(cfg));
    if (patch.role_assignments) this.master.updateRoleConfigs(patch.role_assignments);
    this.publisher.publish('session.config_updated', {
      company_session_id: sessionId, keys: Object.keys(patch), at: Date.now(),
    });
  }

  sendMessageToMaster(
    message: string,
    options: { interject?: boolean; attachments?: import('@mcp/code-agent/index.js').CoderAttachment[]; thinking?: boolean } = {},
  ): { ok: boolean; pending?: 'interactive_wait' } {
    // Lazy-start: sub-session's master is dormant until the first message.
    if (!this.master.isAlive && this.master.agentRunId == null) {
      const session = this.ctx.companyStore.getCompanySession(this.companySessionId);
      let cfg: { master_provider?: string; master_model?: string; role_assignments?: RoleConfig[] } = {};
      try { cfg = session ? JSON.parse(session.config_json || '{}') : {}; } catch { /* defaults */ }
      void this.master.start({
        userMessage: message,
        provider: cfg.master_provider ?? 'anthropic',
        model: cfg.master_model ?? 'claude-sonnet-4-6',
        maxTurns: 100,
        roleConfigs: cfg.role_assignments ?? [],
        attachments: options.attachments,
        thinking: options.thinking,
      }).catch((e) => {
        console.error(`[company s=${this.companySessionId}] lazy master start failed:`, e);
      });
      return { ok: true };
    }
    return this.master.sendUserMessage(message, options);
  }

  getMasterLastUserAttachments(): readonly import('@mcp/code-agent/index.js').CoderAttachment[] { return this.master.getLastUserAttachments(); }
  getRoleDefaults(role: string): ReturnType<MasterLifecycle['getRoleDefaults']> { return this.master.getRoleDefaults(role); }
  /** Project-first view: roles bound to `projectId` via `CompanyRoleConfig.projectIds`. */
  getRolesForProject(projectId: number): string[] {
    return this.master.roleConfigs.filter((r) => Array.isArray(r.projectIds) && r.projectIds.includes(projectId)).map((r) => r.role);
  }
  getProjectIdsForRole(role: string): number[] {
    const entry = this.master.roleConfigs.find((r) => r.role === role);
    return Array.isArray(entry?.projectIds) ? [...entry!.projectIds] : [];
  }
  getAllowedModels(): readonly import('@mcp/company/types.js').AllowedModel[] { return this.master.getAllowedModels(); }
  getPoolDefault(): import('@mcp/company/types.js').AllowedModel | null { return this.master.getPoolDefault(); }

  // ─── Subordinate lifecycle ─────────────────────────────────────
  async spawnSubordinate(spec: SpawnSubordinateSpec): Promise<{ agentRunId: number; coderSessionId: number; status: AgentRunStatus }> {
    return this.subordinates.spawn(spec);
  }
  async resumeSubordinate(agentRunId: number, message?: string, thinking?: boolean): Promise<{ agentRunId: number; coderSessionId: number; status: AgentRunStatus }> {
    const agentRun = this.ctx.companyStore.getAgentRun(agentRunId);
    const roleOverride = agentRun ? this.master.getRoleDefaults(agentRun.role)?.systemPromptOverride : undefined;
    return this.subordinates.resume(agentRunId, message, roleOverride, undefined, thinking);
  }
  async reactivateSubordinate(agentRunId: number, message: string, attachments?: import('@mcp/code-agent/index.js').CoderAttachment[], thinking?: boolean): Promise<boolean> {
    return this.subordinates.reactivate(agentRunId, message, attachments, thinking);
  }
  abortSubordinate(agentRunId: number): boolean { return this.subordinates.abort(agentRunId); }
  pauseSubordinate(agentRunId: number): boolean {
    const sub = this.subordinates.get(agentRunId);
    if (!sub) return false;
    const ok = this.subordinates.pause(agentRunId);
    // The lifecycle helper only wrote the DB row; emit the live
    // `agent_status` (+ board) so the dashboard badge flips to "paused".
    if (ok) this.setAgentStatus(agentRunId, sub.role, 'paused', 'Paused by user');
    return ok;
  }
  getSubordinate(agentRunId: number): SubordinateHandle | undefined { return this.subordinates.get(agentRunId); }
  getSubordinateStatus(agentRunId: number): AgentRunStatus | null { return this.subordinates.statusOf(agentRunId); }
  listSubordinates() { return this.subordinates.list(); }
  hasRunningSubordinates(): boolean { return this.subordinates.runningCount > 0; }
  /** Subscribe to master-attention events (subordinate question/plan/tasks/terminal). */
  onSubordinateAttention(listener: AttentionListener): () => void { return this.attention.on(listener); }
  isSubordinateRunning(agentRunId: number): boolean { return this.subordinates.isRunning(agentRunId); }
  /**
   * True when the master runner has buffered user messages not yet consumed.
   * `wait_for_subordinates` level-triggers off this: if a subordinate
   * notification landed while the master was mid-turn (the edge signal was
   * lost because no listener was subscribed), the master returns from the
   * wait to drain its queue instead of sleeping until the next signal.
   */
  masterHasPendingMessages(): boolean { return this.master.handle?.runner.hasPendingUserMessages() ?? false; }

  // ─── Human-in-the-loop resolvers ───────────────────────────────
  resolveSubordinatePlan(agentRunId: number, approved: boolean, feedback?: string): boolean { return this.humanInLoop.resolvePlan(agentRunId, approved, feedback); }
  resolveSubordinateQuestion(agentRunId: number, answer: string): boolean { return this.humanInLoop.resolveQuestion(agentRunId, answer); }
  resolveSubordinateTasks(agentRunId: number, approved: boolean, feedback?: string, executionMode?: string): boolean { return this.humanInLoop.resolveTasks(agentRunId, approved, feedback, executionMode); }
  hasPendingPlan(agentRunId: number): boolean { return this.humanInLoop.hasPendingPlan(agentRunId); }
  hasPendingQuestion(agentRunId: number): boolean { return this.humanInLoop.hasPendingQuestion(agentRunId); }
  hasPendingTasks(agentRunId: number): boolean { return this.humanInLoop.hasPendingTasks(agentRunId); }

  // ─── Sub-sessions (multi-front via parent_session_id) ──────────
  listChildSessions(): import('@mcp/company/types.js').CompanySession[] {
    return this.ctx.companyStore.listChildSessions(this.companySessionId);
  }
  createChildSession(name: string): import('@mcp/company/types.js').CompanySession {
    const trimmed = (name ?? '').trim();
    if (!trimmed) throw new Error('Sub-session name cannot be empty');
    if (this.parentSessionId != null) throw new Error('Cannot create sub-sessions of a sub-session — use the parent session');
    const child = this.ctx.companyStore.createChildSession({ parent_session_id: this.companySessionId, name: trimmed });
    this.publisher.publish('subsession_created', { session: child });
    return child;
  }
  renameChildSession(childId: number, name: string): void {
    const trimmed = (name ?? '').trim();
    if (!trimmed) throw new Error('Sub-session name cannot be empty');
    const child = this.ctx.companyStore.getCompanySession(childId);
    if (!child || child.parent_session_id !== this.companySessionId) throw new Error(`Sub-session ${childId} not found in this session`);
    this.ctx.companyStore.renameCompanySession(childId, trimmed);
    const updated = this.ctx.companyStore.getCompanySession(childId);
    if (updated) this.publisher.publish('subsession_renamed', { session: updated });
  }

  // ─── Board ─────────────────────────────────────────────────────
  postToBoard(authorRole: string, agentRunId: number | null, kind: 'message' | 'decision' | 'question' | 'deliverable' | 'handoff' | 'blocker', content: string, mentions?: string[]): void {
    this.board.post(authorRole, agentRunId, kind, content, mentions);
  }
  readBoard(opts?: ReadBoardOptions): BoardEntry[] {
    return readBoardWithWatermarks(this.board, this.ctx, this.companySessionId, opts);
  }

  // ─── Kanban ────────────────────────────────────────────────────
  kanbanCreateCard(input: Parameters<KanbanService['createCard']>[0]): KanbanCardFull { return this.kanban.createCard(input); }
  kanbanMoveCard(cardId: number, column: KanbanColumn, position?: number): KanbanCard { return this.kanban.moveCard(cardId, column, position); }
  kanbanUpdateCard(cardId: number, patch: { title?: string; description?: string; tag?: KanbanTag | null }): KanbanCard | null { return this.kanban.updateCard(cardId, patch); }
  kanbanDeleteCard(cardId: number): boolean { return this.kanban.deleteCard(cardId); }
  kanbanAddComment(cardId: number, authorRole: string, agentRunId: number | null, content: string): KanbanComment { return this.kanban.addComment(cardId, authorRole, agentRunId, content); }
  kanbanUpdateChecklist(cardId: number, items: Array<{ id?: number; text: string; checked: boolean }>): KanbanChecklistItem[] { return this.kanban.updateChecklist(cardId, items); }
  kanbanAddDependency(cardId: number, dependsOnId: number): KanbanCardDependency { return this.kanban.addDependency(cardId, dependsOnId); }
  kanbanRemoveDependency(cardId: number, dependsOnId: number): boolean { return this.kanban.removeDependency(cardId, dependsOnId); }
  kanbanAssignAgent(cardId: number, agentRunId: number, role: string): KanbanCardAgent { return this.kanban.assignAgent(cardId, agentRunId, role); }
  kanbanUnassignAgent(cardId: number, agentRunId: number): void { this.kanban.unassignAgent(cardId, agentRunId); }
  kanbanListCards(opts?: { column?: KanbanColumn }): KanbanCard[] { return this.kanban.listCards(opts); }
  kanbanGetCard(cardId: number): KanbanCardFull | null { return this.kanban.getCard(cardId); }
  kanbanListCardsFull(): KanbanCardFull[] { return this.kanban.listCardsFull(); }
  findCardForAgent(agentRunId: number): number | null { return this.kanban.findCardForAgent(agentRunId); }
  getCardContextForSubordinate(cardId: number): string { return this.kanban.getCardContextForSubordinate(cardId); }

  // ─── Projects / status ─────────────────────────────────────────
  listProjects() {
    return this.ctx.projects.map((p) => {
      const proj = this.ctx.db.getProject(p.project_id);
      return { id: p.project_id, name: proj?.name ?? `project-${p.project_id}`, rootPath: proj?.root_path ?? '', label: p.label };
    });
  }
  setAgentStatus(agentRunId: number, role: string, status: string, message: string): void {
    this.status.setStatusWithBoard(agentRunId, role, status as AgentRunStatus, message, {
      post: (a, b, k, c) => this.board.post(a, b, k, c),
    });
  }

  // ─── Sandbox ───────────────────────────────────────────────────
  getSandboxBinding(): SandboxBinding | null { return getSandboxBinding(this.sandboxService, this.parentSessionId); }
  getSandboxServiceBinding(serviceId: string): SandboxBinding | null { return getSandboxServiceBinding(this.sandboxService, this.parentSessionId, serviceId); }
  getSandboxStackForService(serviceId?: string | null): string | null { return this.sandboxService.getStackForService(serviceId ?? null); }
  listSandboxPeers(selfServiceId?: string | null): SandboxPeer[] { return listSandboxPeers(this.sandboxService, this.parentSessionId, selfServiceId); }
  async provisionSandboxIfNeeded(signal?: AbortSignal): Promise<SandboxBinding | null> { return provisionSandboxIfNeeded(this.sandboxService, this.parentSessionId, signal); }

  // ─── Shutdown ──────────────────────────────────────────────────
  abortAll(opts: { teardownSandbox?: boolean; finalStatus?: 'error' | 'idle' } = {}): void {
    const teardownSandbox = opts.teardownSandbox ?? true;
    const finalStatus = opts.finalStatus ?? 'error';
    this.ctx.markAborted();
    this.idle.clear();
    this.watchdog.dispose();
    this.reconciler.stop();
    this.subordinates.abortAll();
    this.master.abort();
    try { this.humanInLoop.cancelPendingMasterPrompts(); } catch { /* best-effort */ }
    try { this.ctx.companyStore.updateCompanySessionStatus(this.companySessionId, finalStatus); } catch { /* ignore */ }
    // Sub-sessions don't own a sandbox — teardown would target the parent's
    // container, which siblings still depend on.
    if (teardownSandbox && this.parentSessionId == null) {
      // Best-effort; fire-and-forget. abortAll is often called from signal
      // handlers where we can't block on a container removal round-trip.
      void this.sandboxService.teardown('aborted').catch(() => void 0);
    }
    this.publisher.markEnded('done', { reason: 'aborted' });
  }
  finalizeAllSubordinates(): { finalized: number; alreadyStopped: number } { return this.subordinates.finalizeAll(); }
  /** Mem C — distill board decisions/blockers/deliverables into per-project
   *  memory snapshots. Fired (fire-and-forget) by `finalize_subordinates`;
   *  best-effort and semantically deduped, so a double call is harmless. */
  consolidateMemory(): Promise<{ projects: number; entries: number }> {
    return consolidateBoardToMemory({
      companySessionId: this.companySessionId,
      companyStore: this.ctx.companyStore,
      db: this.ctx.db,
      projects: this.ctx.projects,
    });
  }

  // ─── Pipelines ─────────────────────────────────────────────────
  pipelineList(opts?: { scope?: 'this' | 'global' | 'all'; templateId?: number | null }): Pipeline[] {
    if (opts?.scope === 'this') return this.pipelines.list({ companySessionId: this.companySessionId, templateId: opts.templateId ?? undefined });
    if (opts?.scope === 'global') return this.pipelines.list({ companySessionId: null, templateId: opts.templateId ?? undefined });
    return this.pipelines.list({ templateId: opts?.templateId ?? undefined });
  }
  pipelineGet(id: number): Pipeline | null { return this.pipelines.get(id); }
  pipelineCreate(input: { name: string; description?: string; graph: PipelineGraph; scope?: 'this' | 'global'; templateId?: number | null }): Pipeline {
    return this.pipelines.create({
      name: input.name, description: input.description, graph: input.graph,
      companySessionId: input.scope === 'global' ? null : this.companySessionId,
      templateId: input.templateId ?? null,
    });
  }
  pipelineUpdate(id: number, patch: { name?: string; description?: string; graph?: PipelineGraph }, opts?: { expectedVersion?: number }): Pipeline | null { return this.pipelines.update(id, patch, opts); }
  pipelineDelete(id: number): boolean { return this.pipelines.delete(id); }
  /** Validate a graph against the session's role roster. */
  pipelineValidate(graph: PipelineGraph): PipelineValidationResult {
    return this.pipelines.validate(graph, new Set(this.master.roleConfigs.map((r) => r.role)));
  }
  async pipelineStart(pipelineId: number, initialInput: string, startedBy?: string): Promise<PipelineExecution> { return this.pipelineExecutor.start(pipelineId, initialInput, startedBy); }
  pipelineAbort(executionId: number, reason?: string): boolean { return this.pipelineExecutor.abort(executionId, reason); }
  pipelinePause(executionId: number): boolean { return this.pipelineExecutor.pause(executionId); }
  async pipelineResume(executionId: number): Promise<boolean> { return this.pipelineExecutor.resume(executionId); }
  /** Approve a `requires_confirmation` pause (re-runs the gated next node). */
  async pipelineConfirm(executionId: number): Promise<boolean> { return this.pipelineExecutor.confirm(executionId); }
  /** Boot-time recovery: any run still `running` in DB has no in-memory listener → flip to `paused` and emit. */
  async pipelineRecoverRunning(): Promise<{ paused: number }> { return this.pipelineExecutor.recoverRunning(); }
  pipelineStatus(executionId: number): { execution: PipelineExecution; nodes: PipelineNodeExecution[] } | null { return this.pipelineExecutor.status(executionId); }
  pipelineListExecutions(opts?: { pipelineId?: number; status?: PipelineExecutionStatus; limit?: number }): PipelineExecution[] { return this.pipelineExecutor.listExecutions(opts); }

  // ─── Agent inbox ───────────────────────────────────────────────
  inboxSend(args: InboxSendArgs): InboxSendResult { return this.inbox.send(args); }
  inboxRespond(messageId: number, answer: string): boolean { return this.inbox.respond(messageId, answer); }
  /** C9 — Async send poll. `check_inbox_answer` calls this to poll a fire-and-forget message. */
  inboxStatus(messageId: number): { status: InboxStatus; answer: string | null; deliveredAt: string | null; answeredAt: string | null } | null { return this.inbox.getMessageStatus(messageId); }
  inboxCancel(messageId: number, reason: string): boolean { return this.inbox.cancel(messageId, reason); }
  inboxList(opts?: { status?: InboxStatus | InboxStatus[]; toRole?: string; toAgentRunId?: number; fromAgentRunId?: number; limit?: number }): AgentInboxMessage[] {
    return this.inbox.list(opts ?? {});
  }
  /** Block until the inbox message identified by `waitToken` is answered. */
  inboxWait(waitToken: string, timeoutMs?: number): Promise<string> { return this.inbox.waitForAnswer(waitToken, timeoutMs); }
  inboxDetectCycle(args: { fromAgentRunId: number; toRole?: string; toAgentRunId?: number }): boolean { return this.inbox.detectCycle(args); }
  /** Manually flush pending master inbox messages — boot-time and after rehydration. */
  revivePendingMasters(): void { this.masterInbox.reviveIfPending(); }
}
