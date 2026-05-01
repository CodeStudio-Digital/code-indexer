/**
 * CompanyOrchestrator — facade that composes the focused services that
 * actually own the domain logic.
 *
 * Services (see `./services/`):
 *   - SessionContext            — shared state (store, db, bus, projects, abort)
 *   - MetaBusPublisher/Wirer    — meta-bus fan-out (event forwarding)
 *   - BoardBridge               — board posts + kanban auto-hook + watermark
 *   - KanbanService             — kanban CRUD + meta-bus events
 *   - AgentStatusUpdater        — centralises `company_agent_runs.status`
 *   - HumanInTheLoop            — pending plan/question/tasks registries
 *   - IdleController            — paused-state transition + idle timeout
 *   - SubordinateLifecycle      — spawn/resume/auto-retry/concurrency cap
 *   - MasterLifecycle           — start/resume/resurrect/notify/swap
 *
 * This class is thin: it wires services, owns `metaBus`, and delegates
 * the public API so existing callers (tools, HTTP routes, CompanyContext
 * consumers) keep working unchanged.
 */

import type { RunCoderHandle } from '../index.js';
import { createBus, type CoderRunBus } from '../../../apps/http-api/coder-bus.js';
import type { CompanyStore } from '../../../store/company-store.js';
import type { CodeIndexDB } from '../../../store/db.js';
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
} from './types.js';

import { SessionContext } from './services/SessionContext.js';
import { MetaBusPublisher } from './services/MetaBusPublisher.js';
import { MetaBusWirer } from './services/MetaBusWirer.js';
import { KanbanService } from './services/KanbanService.js';
import { BoardBridge } from './services/BoardBridge.js';
import { AgentStatusUpdater } from './services/AgentStatusUpdater.js';
import { HumanInTheLoop } from './services/HumanInTheLoop.js';
import { IdleController } from './services/IdleController.js';
import { SubordinateLifecycle, type SpawnSubordinateSpec } from './services/SubordinateLifecycle.js';
import { MasterLifecycle, type RoleConfig } from './services/MasterLifecycle.js';
import { MasterAttention, type AttentionListener } from './services/MasterAttention.js';
import { SandboxService } from './services/SandboxService.js';
import { PipelineService, type PipelineValidationResult } from './services/PipelineService.js';
import { PipelineExecutor } from './services/PipelineExecutor.js';
import { InboxQueue, type SendArgs as InboxSendArgs, type SendResult as InboxSendResult } from './services/InboxQueue.js';
import type {
  AgentInboxMessage,
  InboxStatus,
  Pipeline,
  PipelineExecution,
  PipelineExecutionStatus,
  PipelineGraph,
  PipelineNodeExecution,
  SandboxBinding,
} from './types.js';

export type { SpawnSubordinateSpec };

export interface CompanyOrchestratorOpts {
  companySessionId: number;
  companyStore: CompanyStore;
  db: CodeIndexDB;
}

export class CompanyOrchestrator {
  // ─── Public properties (kept for BC with tools / HTTP routes) ───

  readonly companySessionId: number;
  readonly metaBus: CoderRunBus;

  // ─── Services (composed) ────────────────────────────────────────

  private readonly ctx: SessionContext;
  private readonly publisher: MetaBusPublisher;
  private readonly wirer: MetaBusWirer;
  private readonly kanban: KanbanService;
  private readonly board: BoardBridge;
  private readonly status: AgentStatusUpdater;
  private readonly attention: MasterAttention;
  /** Builder-mode sandbox bridge. Dormant when the session has no `builder` config. */
  readonly sandboxService: SandboxService;
  // These four have a small construction cycle (Master ↔ HumanInTheLoop,
  // Subordinates ↔ Idle); they're assigned inside the constructor body.
  private readonly humanInLoop!: HumanInTheLoop;
  private readonly idle!: IdleController;
  private readonly subordinates!: SubordinateLifecycle;
  private readonly master!: MasterLifecycle;
  // Pipelines depend on `subordinates` so they're constructed below.
  private readonly pipelines!: PipelineService;
  private readonly pipelineExecutor!: PipelineExecutor;
  // Inbox queue is constructed alongside pipelines and back-wired
  // into `subordinates` via `setOnSubordinateIdle`.
  private readonly inbox!: InboxQueue;

  constructor(opts: CompanyOrchestratorOpts) {
    this.companySessionId = opts.companySessionId;
    this.metaBus = createBus(new AbortController());

    this.ctx = new SessionContext({
      companySessionId: opts.companySessionId,
      companyStore: opts.companyStore,
      db: opts.db,
      metaBus: this.metaBus,
    });

    this.publisher = new MetaBusPublisher(this.metaBus);
    this.wirer = new MetaBusWirer(this.publisher);
    // Dormant for non-builder sessions. `provisionIfNeeded` inspects
    // `CompanySession.config_json` and returns null when `builder` is
    // absent — so existing sessions feel zero overhead.
    this.sandboxService = new SandboxService(this.ctx, this.publisher);
    this.kanban = new KanbanService(this.ctx, this.publisher);
    this.board = new BoardBridge(this.ctx, this.publisher, this.kanban);
    this.status = new AgentStatusUpdater(this.ctx, this.publisher);
    this.attention = new MasterAttention();

    // Construction has small cycles (Master ↔ HumanInTheLoop wire each
    // other; Subordinates ↔ IdleController query each other). We resolve
    // this by passing mutable `deps` objects that get filled in after all
    // services exist, then wiring the final references.
    const masterDeps: ConstructorParameters<typeof MasterLifecycle>[0] = {
      ctx: this.ctx,
      board: this.board,
      status: this.status,
      humanInLoop: undefined as unknown as HumanInTheLoop,
      wirer: this.wirer,
      idle: undefined as unknown as IdleController,
      orchestratorRef: this,
    };
    const master = new MasterLifecycle(masterDeps);
    (this as unknown as { master: MasterLifecycle }).master = master;

    const humanInLoop = new HumanInTheLoop(
      this.publisher,
      this.board,
      this.status,
      master,
      this.attention,
      this.ctx,
    );
    (this as unknown as { humanInLoop: HumanInTheLoop }).humanInLoop = humanInLoop;
    masterDeps.humanInLoop = humanInLoop;

    const subordinateDeps: ConstructorParameters<typeof SubordinateLifecycle>[0] = {
      ctx: this.ctx,
      board: this.board,
      status: this.status,
      kanban: this.kanban,
      master,
      humanInLoop,
      wirer: this.wirer,
      idle: undefined as unknown as IdleController,
      orchestratorRef: this,
      attention: this.attention,
    };
    const subordinates = new SubordinateLifecycle(subordinateDeps);
    (this as unknown as { subordinates: SubordinateLifecycle }).subordinates = subordinates;

    const idle = new IdleController({
      ctx: this.ctx,
      bus: this.publisher,
      subordinates,
      master: {
        get endedWithError() { return master.endedWithError; },
        get hasEnded() { return master.hasEnded; },
      },
      consumeMasterShouldContinue: () =>
        humanInLoop.consumeMasterShouldContinue() || master.consumeShouldContinue(),
      onAutoContinue: () => {
        master.notify(
          '[SYSTEM] The human has responded. Continue orchestrating — call the appropriate tools to proceed with the next steps.',
        );
      },
    });
    (this as unknown as { idle: IdleController }).idle = idle;

    masterDeps.idle = idle;
    subordinateDeps.idle = idle;

    // Pipelines: thin CRUD + executor that drives subordinates through a
    // stored graph. Constructed last because the executor needs the
    // already-wired `subordinates` and `attention`.
    const pipelines = new PipelineService(this.ctx);
    (this as unknown as { pipelines: PipelineService }).pipelines = pipelines;
    const pipelineExecutor = new PipelineExecutor({
      ctx: this.ctx,
      pipelines,
      kanban: this.kanban,
      subordinates,
      attention: this.attention,
      publisher: this.publisher,
    });
    (this as unknown as { pipelineExecutor: PipelineExecutor }).pipelineExecutor = pipelineExecutor;

    // Inbox: persistent message queue between subordinates. The
    // SubordinateLifecycle's idle hook is wired here (late-bound)
    // because the queue needs `subordinates.reactivate` and the
    // lifecycle was constructed before the queue.
    const inbox = new InboxQueue({
      ctx: this.ctx,
      subordinates,
      attention: this.attention,
      publisher: this.publisher,
    });
    (this as unknown as { inbox: InboxQueue }).inbox = inbox;
    subordinates.setOnSubordinateIdle((agentRunId, role) => {
      void inbox.drainOnIdle(agentRunId, role);
    });
  }

  // ─── BC: exposed runtime state ──────────────────────────────────

  /** @deprecated — prefer getMasterHandle(). Kept for tools/HTTP that read it directly. */
  get masterHandle(): RunCoderHandle | null {
    return this.master.handle;
  }

  getMasterAgentRunId(): number | null {
    return this.master.agentRunId;
  }

  // ─── Master lifecycle ───────────────────────────────────────────

  async startMaster(opts: {
    userMessage: string;
    provider: string;
    model: string;
    maxTurns?: number;
    signal?: AbortSignal;
    roleConfigs?: RoleConfig[];
  }): Promise<RunCoderHandle> {
    return this.master.start(opts);
  }

  async resumeExistingMaster(opts: {
    userMessage: string;
    maxTurns?: number;
    roleConfigs?: RoleConfig[];
  }): Promise<RunCoderHandle> {
    return this.master.resumeExisting(opts);
  }

  notifyMasterAboutSubordinate(message: string): void {
    this.master.notify(message);
  }

  respondToMasterPlan(approved: boolean, feedback?: string, promptId?: number) {
    return this.humanInLoop.respondToMasterPlan(approved, feedback, promptId);
  }

  respondToMasterQuestion(answer: string, promptId?: number) {
    return this.humanInLoop.respondToMasterQuestion(answer, promptId);
  }

  async swapMasterProvider(providerName: string, model?: string): Promise<{ provider: string; model: string }> {
    return this.master.swapProvider(providerName, model);
  }

  updateRoleConfigs(roleConfigs: RoleConfig[]): void {
    this.master.updateRoleConfigs(roleConfigs);
  }

  /**
   * Apply a partial config patch to a running session and persist it.
   * Reuses `updateRoleConfigs` for the runtime propagation of
   * role_assignments, then merges the new values into `config_json` so
   * a server restart surfaces the edit. Skills and allowed_models do
   * not require a restart — they affect future subordinate spawns
   * (which read the pool from the session row on each `spawn_subordinate_agent`
   * call) and the master's rendered roster on its next refresh.
   *
   * `role_assignments` is the authoritative update path for running
   * agents; swapping provider/model for already-spawned subordinates is
   * still done via `master.swapProvider` / the in-memory master API.
   */
  applyConfigPatch(patch: {
    role_assignments?: RoleConfig[];
    skills?: Record<string, string[]>;
    allowed_models?: import('./types.js').AllowedModel[];
  }): void {
    const sessionId = this.ctx.companySessionId;
    const row = this.ctx.companyStore.getCompanySession(sessionId);
    if (!row) throw new Error(`Company session ${sessionId} not found`);
    let cfg: Record<string, unknown> = {};
    try {
      cfg = JSON.parse(row.config_json || '{}');
    } catch {
      cfg = {};
    }
    if (patch.role_assignments) cfg.role_assignments = patch.role_assignments;
    if (patch.skills) cfg.skills = patch.skills;
    if (patch.allowed_models) cfg.allowed_models = patch.allowed_models;
    this.ctx.companyStore.updateCompanySessionConfig(sessionId, JSON.stringify(cfg));

    if (patch.role_assignments) {
      this.master.updateRoleConfigs(patch.role_assignments);
    }
    this.publisher.publish('session.config_updated', {
      company_session_id: sessionId,
      keys: Object.keys(patch),
      at: Date.now(),
    });
  }

  sendMessageToMaster(
    message: string,
    options: { interject?: boolean } = {},
  ): { ok: boolean; pending?: 'interactive_wait' } {
    return this.master.sendUserMessage(message, options);
  }

  getRoleDefaults(role: string): { provider?: string; model?: string; tier?: string; skills?: import('./types.js').RoleSkills; systemPromptOverride?: string; projectIds?: number[]; temperature?: number } | null {
    return this.master.getRoleDefaults(role);
  }

  /**
   * Project-first view: for a given project id, returns the roles bound to
   * it via `CompanyRoleConfig.projectIds`. Used by the master prompt to
   * render the "Project → Roles" section and by consumers that want to
   * think project-first ("who works here?") instead of role-first.
   */
  getRolesForProject(projectId: number): string[] {
    return this.master.roleConfigs
      .filter((r) => Array.isArray(r.projectIds) && r.projectIds.includes(projectId))
      .map((r) => r.role);
  }

  /**
   * Project bindings for a role in this session. Returns an empty array
   * when the role has no bindings (legacy free-form behaviour).
   */
  getProjectIdsForRole(role: string): number[] {
    const entry = this.master.roleConfigs.find((r) => r.role === role);
    return Array.isArray(entry?.projectIds) ? [...entry!.projectIds] : [];
  }

  /**
   * Curated pool of (provider, model) tuples the master is allowed to
   * spawn subordinates with. Consulted by `SubordinateLifecycle.spawn`
   * as a guard and rendered in the master's prompt. Empty = no
   * restriction (session predates the feature or operator left it off).
   */
  getAllowedModels(): readonly import('./types.js').AllowedModel[] {
    return this.master.getAllowedModels();
  }

  /**
   * Default (provider, model) pair the master should use when it
   * spawns WITHOUT specifying one and the role isn't in the template.
   * Returns null when the pool is empty — caller falls back to the
   * historical hardcoded defaults.
   */
  getPoolDefault(): import('./types.js').AllowedModel | null {
    return this.master.getPoolDefault();
  }

  // ─── Subordinate lifecycle ──────────────────────────────────────

  async spawnSubordinate(spec: SpawnSubordinateSpec): Promise<{
    agentRunId: number;
    coderSessionId: number;
    status: AgentRunStatus;
  }> {
    return this.subordinates.spawn(spec);
  }

  async resumeSubordinate(agentRunId: number, message?: string): Promise<{
    agentRunId: number;
    coderSessionId: number;
    status: AgentRunStatus;
  }> {
    const agentRun = this.ctx.companyStore.getAgentRun(agentRunId);
    const roleOverride = agentRun ? this.master.getRoleDefaults(agentRun.role)?.systemPromptOverride : undefined;
    return this.subordinates.resume(agentRunId, message, roleOverride);
  }

  async reactivateSubordinate(agentRunId: number, message: string): Promise<boolean> {
    return this.subordinates.reactivate(agentRunId, message);
  }

  abortSubordinate(agentRunId: number): boolean {
    return this.subordinates.abort(agentRunId);
  }

  getSubordinate(agentRunId: number): SubordinateHandle | undefined {
    return this.subordinates.get(agentRunId);
  }

  getSubordinateStatus(agentRunId: number): AgentRunStatus | null {
    return this.subordinates.statusOf(agentRunId);
  }

  listSubordinates() {
    return this.subordinates.list();
  }

  hasRunningSubordinates(): boolean {
    return this.subordinates.runningCount > 0;
  }

  /**
   * Subscribe to master-attention events (subordinate posted a
   * question/plan/tasks, or transitioned to a terminal status).
   * Used by `wait_for_subordinates` so the master wakes in real time
   * instead of polling. Returns an unsubscribe function.
   */
  onSubordinateAttention(listener: AttentionListener): () => void {
    return this.attention.on(listener);
  }

  isSubordinateRunning(agentRunId: number): boolean {
    return this.subordinates.isRunning(agentRunId);
  }

  // ─── Human-in-the-loop resolvers ────────────────────────────────

  resolveSubordinatePlan(agentRunId: number, approved: boolean, feedback?: string): boolean {
    return this.humanInLoop.resolvePlan(agentRunId, approved, feedback);
  }

  resolveSubordinateQuestion(agentRunId: number, answer: string): boolean {
    return this.humanInLoop.resolveQuestion(agentRunId, answer);
  }

  resolveSubordinateTasks(
    agentRunId: number,
    approved: boolean,
    feedback?: string,
    executionMode?: string,
  ): boolean {
    return this.humanInLoop.resolveTasks(agentRunId, approved, feedback, executionMode);
  }

  hasPendingPlan(agentRunId: number): boolean { return this.humanInLoop.hasPendingPlan(agentRunId); }
  hasPendingQuestion(agentRunId: number): boolean { return this.humanInLoop.hasPendingQuestion(agentRunId); }
  hasPendingTasks(agentRunId: number): boolean { return this.humanInLoop.hasPendingTasks(agentRunId); }

  // ─── Board ──────────────────────────────────────────────────────

  postToBoard(
    authorRole: string,
    agentRunId: number | null,
    kind: 'message' | 'decision' | 'question' | 'deliverable' | 'handoff',
    content: string,
    mentions?: string[],
  ): void {
    this.board.post(authorRole, agentRunId, kind, content, mentions);
  }

  readBoard(opts?: { sinceId?: number; limit?: number; mentionsRole?: string }): BoardEntry[] {
    return this.board.read(opts);
  }

  // ─── Kanban ─────────────────────────────────────────────────────

  kanbanCreateCard(input: Parameters<KanbanService['createCard']>[0]): KanbanCardFull {
    return this.kanban.createCard(input);
  }
  kanbanMoveCard(cardId: number, column: KanbanColumn, position?: number): KanbanCard {
    return this.kanban.moveCard(cardId, column, position);
  }
  kanbanUpdateCard(cardId: number, patch: { title?: string; description?: string; tag?: KanbanTag | null }): KanbanCard | null {
    return this.kanban.updateCard(cardId, patch);
  }
  kanbanDeleteCard(cardId: number): boolean { return this.kanban.deleteCard(cardId); }
  kanbanAddComment(cardId: number, authorRole: string, agentRunId: number | null, content: string): KanbanComment {
    return this.kanban.addComment(cardId, authorRole, agentRunId, content);
  }
  kanbanUpdateChecklist(cardId: number, items: Array<{ id?: number; text: string; checked: boolean }>): KanbanChecklistItem[] {
    return this.kanban.updateChecklist(cardId, items);
  }
  kanbanAddDependency(cardId: number, dependsOnId: number): KanbanCardDependency {
    return this.kanban.addDependency(cardId, dependsOnId);
  }
  kanbanRemoveDependency(cardId: number, dependsOnId: number): boolean {
    return this.kanban.removeDependency(cardId, dependsOnId);
  }
  kanbanAssignAgent(cardId: number, agentRunId: number, role: string): KanbanCardAgent {
    return this.kanban.assignAgent(cardId, agentRunId, role);
  }
  kanbanUnassignAgent(cardId: number, agentRunId: number): void {
    this.kanban.unassignAgent(cardId, agentRunId);
  }
  kanbanListCards(opts?: { column?: KanbanColumn }): KanbanCard[] { return this.kanban.listCards(opts); }
  kanbanGetCard(cardId: number): KanbanCardFull | null { return this.kanban.getCard(cardId); }
  kanbanListCardsFull(): KanbanCardFull[] { return this.kanban.listCardsFull(); }
  findCardForAgent(agentRunId: number): number | null { return this.kanban.findCardForAgent(agentRunId); }
  getCardContextForSubordinate(cardId: number): string { return this.kanban.getCardContextForSubordinate(cardId); }

  // ─── Projects / status ─────────────────────────────────────────

  listProjects() {
    return this.ctx.projects.map((p) => {
      const proj = this.ctx.db.getProject(p.project_id);
      return {
        id: p.project_id,
        name: proj?.name ?? `project-${p.project_id}`,
        rootPath: proj?.root_path ?? '',
        label: p.label,
      };
    });
  }

  setAgentStatus(agentRunId: number, role: string, status: string, message: string): void {
    this.status.setStatusWithBoard(
      agentRunId,
      role,
      status as AgentRunStatus,
      message,
      { post: (a, b, k, c) => this.board.post(a, b, k, c) },
    );
  }

  // ─── Shutdown ──────────────────────────────────────────────────

  /**
   * Returns the active builder sandbox binding for this session, or null
   * when the session runs in traditional mode. Master/Subordinate
   * lifecycles read this to enrich their `CompanyContext`.
   */
  getSandboxBinding(): SandboxBinding | null {
    return this.sandboxService.getBinding();
  }

  /**
   * Returns the secondary-service binding for `serviceId`, or null when
   * this session has no service by that id. Subordinates working on a
   * microservice project MUST use this instead of `getSandboxBinding`
   * (which returns the primary/master container) — otherwise their
   * tool writes land in the master's workdir rather than the service's
   * own bind-mounted host dir.
   */
  getSandboxServiceBinding(serviceId: string): SandboxBinding | null {
    return this.sandboxService.getServiceBinding(serviceId);
  }

  /**
   * Stack name for the prompt builders. When `serviceId` is given and
   * the session is multi-container, returns that service's configured
   * stack; otherwise returns the primary/legacy stack. `null` when the
   * session isn't in builder mode.
   */
  getSandboxStackForService(serviceId?: string | null): string | null {
    return this.sandboxService.getStackForService(serviceId ?? null);
  }

  /**
   * Snapshot of all sandbox containers alive on this session (primary +
   * secondaries) annotated with the `internalUrl` siblings use to reach
   * each other on the shared docker network. Used by both the
   * system-prompt builder (so every subordinate knows which peers
   * exist) and the read-only `list_services` tool. `selfServiceId`
   * marks the caller's own container — pass `null` when no particular
   * service is "self" (e.g. master perspective).
   *
   * The internal port matches the dev-server convention (5173 by
   * default; MCP_SANDBOX_DEV_PORT overrides). Hostname is the
   * service_id — `main` for the primary legacy/multi service.
   */
  listSandboxPeers(
    selfServiceId?: string | null,
  ): Array<{
    serviceId: string;
    stack: string;
    internalUrl: string;
    previewUrl: string;
    isSelf: boolean;
  }> {
    const devPort = Number(process.env.MCP_SANDBOX_DEV_PORT ?? 5173);
    const peers: Array<{
      serviceId: string;
      stack: string;
      internalUrl: string;
      previewUrl: string;
      isSelf: boolean;
    }> = [];
    const primary = this.sandboxService.getBinding();
    if (primary) {
      const id = primary.serviceId ?? 'main';
      peers.push({
        serviceId: id,
        stack: this.sandboxService.getStackForService(null) ?? 'unknown',
        internalUrl: `http://${id}:${devPort}`,
        previewUrl: primary.previewUrl,
        isSelf: (selfServiceId ?? 'main') === id,
      });
    }
    for (const { serviceId, binding } of this.sandboxService.listServiceBindings()) {
      peers.push({
        serviceId,
        stack: this.sandboxService.getStackForService(serviceId) ?? 'unknown',
        internalUrl: `http://${serviceId}:${devPort}`,
        previewUrl: binding.previewUrl,
        isSelf: (selfServiceId ?? null) === serviceId,
      });
    }
    return peers;
  }

  /**
   * Provision the sandbox on demand. Safe to call multiple times — the
   * service is idempotent. Meant to be called by `MasterLifecycle.start`
   * before `runCoder` so the binding is available to weave into the
   * master's (and subsequently subordinates') `CompanyContext`.
   */
  async provisionSandboxIfNeeded(signal?: AbortSignal): Promise<SandboxBinding | null> {
    return await this.sandboxService.provisionIfNeeded({ signal });
  }

  abortAll(opts: { teardownSandbox?: boolean; finalStatus?: 'error' | 'idle' } = {}): void {
    const teardownSandbox = opts.teardownSandbox ?? true;
    const finalStatus = opts.finalStatus ?? 'error';
    this.ctx.markAborted();
    this.idle.clear();
    this.subordinates.abortAll();
    this.master.abort();
    try {
      this.humanInLoop.cancelPendingMasterPrompts();
    } catch { /* best-effort */ }
    try {
      this.ctx.companyStore.updateCompanySessionStatus(this.companySessionId, finalStatus);
    } catch { /* ignore */ }
    if (teardownSandbox) {
      // Best-effort sandbox teardown. Fire-and-forget: abortAll is often
      // called from signal handlers where we can't block on a container
      // removal round-trip. The manager's reaper + process shutdown hook
      // provide a safety net for anything left over.
      void this.sandboxService.teardown('aborted').catch(() => void 0);
    }
    this.publisher.markEnded('done', { reason: 'aborted' });
  }

  finalizeAllSubordinates(): { finalized: number; alreadyStopped: number } {
    return this.subordinates.finalizeAll();
  }

  // ─── Pipelines ─────────────────────────────────────────────────

  pipelineList(opts?: {
    /** Pass `'this'` to scope to the current session + globals; `'global'` for globals only; `'all'` for everything (default). */
    scope?: 'this' | 'global' | 'all';
    templateId?: number | null;
  }): Pipeline[] {
    if (opts?.scope === 'this') {
      return this.pipelines.list({ companySessionId: this.companySessionId, templateId: opts.templateId ?? undefined });
    }
    if (opts?.scope === 'global') {
      return this.pipelines.list({ companySessionId: null, templateId: opts.templateId ?? undefined });
    }
    return this.pipelines.list({ templateId: opts?.templateId ?? undefined });
  }

  pipelineGet(id: number): Pipeline | null {
    return this.pipelines.get(id);
  }

  pipelineCreate(input: {
    name: string;
    description?: string;
    graph: PipelineGraph;
    /** Pass `'this'` to bind to the current session, `'global'` to keep reusable across sessions. Defaults to `'this'`. */
    scope?: 'this' | 'global';
    templateId?: number | null;
  }): Pipeline {
    return this.pipelines.create({
      name: input.name,
      description: input.description,
      graph: input.graph,
      companySessionId: input.scope === 'global' ? null : this.companySessionId,
      templateId: input.templateId ?? null,
    });
  }

  pipelineUpdate(
    id: number,
    patch: { name?: string; description?: string; graph?: PipelineGraph },
    opts?: { expectedVersion?: number },
  ): Pipeline | null {
    return this.pipelines.update(id, patch, opts);
  }

  pipelineDelete(id: number): boolean {
    return this.pipelines.delete(id);
  }

  /**
   * Validate a graph against the session's role roster. Returns a
   * structured result so dashboards can highlight offending nodes/edges.
   */
  pipelineValidate(graph: PipelineGraph): PipelineValidationResult {
    const validRoles = new Set(this.master.roleConfigs.map((r) => r.role));
    return this.pipelines.validate(graph, validRoles);
  }

  async pipelineStart(
    pipelineId: number,
    initialInput: string,
    startedBy?: string,
  ): Promise<PipelineExecution> {
    return this.pipelineExecutor.start(pipelineId, initialInput, startedBy);
  }

  pipelineAbort(executionId: number, reason?: string): boolean {
    return this.pipelineExecutor.abort(executionId, reason);
  }

  pipelinePause(executionId: number): boolean {
    return this.pipelineExecutor.pause(executionId);
  }

  async pipelineResume(executionId: number): Promise<boolean> {
    return this.pipelineExecutor.resume(executionId);
  }

  /**
   * Boot-time recovery: any execution still marked `running` in the DB
   * after a server restart has no in-memory listener, so we flip it to
   * `paused` and emit `pipeline_paused` so the dashboard surfaces a
   * Resume button. Idempotent.
   */
  async pipelineRecoverRunning(): Promise<{ paused: number }> {
    return this.pipelineExecutor.recoverRunning();
  }

  pipelineStatus(executionId: number): {
    execution: PipelineExecution;
    nodes: PipelineNodeExecution[];
  } | null {
    return this.pipelineExecutor.status(executionId);
  }

  pipelineListExecutions(opts?: {
    pipelineId?: number;
    status?: PipelineExecutionStatus;
    limit?: number;
  }): PipelineExecution[] {
    return this.pipelineExecutor.listExecutions(opts);
  }

  // ─── Agent inbox ────────────────────────────────────────────────

  inboxSend(args: InboxSendArgs): InboxSendResult {
    return this.inbox.send(args);
  }

  inboxRespond(messageId: number, answer: string): boolean {
    return this.inbox.respond(messageId, answer);
  }

  inboxCancel(messageId: number, reason: string): boolean {
    return this.inbox.cancel(messageId, reason);
  }

  inboxList(opts?: {
    status?: InboxStatus | InboxStatus[];
    toRole?: string;
    toAgentRunId?: number;
    fromAgentRunId?: number;
    limit?: number;
  }): AgentInboxMessage[] {
    return this.inbox.list(opts ?? {});
  }

  /**
   * Block until the inbox message identified by `waitToken` is
   * answered. Throws on timeout. Used by the `send_to_agent` tool
   * when called with `wait=true` so a synchronous-feeling Q&A
   * round-trip is one tool call.
   */
  inboxWait(waitToken: string, timeoutMs?: number): Promise<string> {
    return this.inbox.waitForAnswer(waitToken, timeoutMs);
  }

  inboxDetectCycle(args: {
    fromAgentRunId: number;
    toRole?: string;
    toAgentRunId?: number;
  }): boolean {
    return this.inbox.detectCycle(args);
  }
}
