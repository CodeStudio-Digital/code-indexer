/**
 * CompanyOrchestrator — facade that composes the focused services owning the
 * domain logic. Service wiring lives in `./orchestrator/wire-services.ts`;
 * sandbox helpers in `./orchestrator/sandbox-helpers.ts`; the watermark-aware
 * board read in `./orchestrator/board-helpers.ts`. This class is thin: it
 * keeps `metaBus`, exposes service handles, and delegates the public API so
 * tools / HTTP routes / CompanyContext consumers keep working unchanged.
 */
import type { MasterStartResult } from '@mcp/code-agent/index.js';
import type { CoderRunBus } from '@apps/http-api/coder-bus.js';
import type { CompanyStore } from '@mcp/store/company-store.js';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { FsSessionStore } from '@mcp/code-agent/sessions/fs-store/fs-session-store.js';
import {
  asCompanySessionId,
  type CompanySessionId,
} from '@mcp/session-storage';
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
import type { AgentInboxMessage, InboxStatus, SandboxBinding } from '@mcp/company/types.js';

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
import type { InboxQueue, SendArgs as InboxSendArgs, SendResult as InboxSendResult } from './services/InboxQueue.js';
import type { MasterInboxRouter } from './services/MasterInboxRouter.js';
import type { RuntimeReconciler } from './services/RuntimeReconciler.js';
import type { ServiceSupervisor } from './services/service-supervisor/ServiceSupervisor.js';
import type { CompanyScheduler } from './services/scheduler/CompanyScheduler.js';
import type { AppStudioScheduler } from './services/scheduler/AppStudioScheduler.js';
import { dispatchCard, type DispatchCardResult } from './services/scheduler/dispatch-card.js';
import { getGlobalCompanyRecommend } from './services/scheduler/recommend-shim.js';
import type { CompanyDriveStore } from './services/CompanyDriveStore.js';
import type { CompanyEventBus } from './services/CompanyEventBus.js';
import type { IdleWatchdog } from './services/IdleWatchdog.js';

import type { AutonomyProvider } from './services/autonomy/autonomy-provider.js';
import { mergeAutonomyPatch, type AutonomyPatch } from './services/autonomy/autonomy-patch.js';
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
import {
  readRoleRuntimePolicy,
  resolveEffectiveMasterRuntime,
} from './services/subordinate/role-runtime.js';
import { CompanyCapabilityUnavailableError } from './services/session-capabilities.js';

export type { SpawnSubordinateSpec };

export interface CompanyOrchestratorOpts {
  companySessionId: CompanySessionId | string;
  sessionStore: FsSessionStore;
  companyStore: CompanyStore;
  db: CodeIndexDB;
}

export class CompanyOrchestrator {
  readonly companySessionId: CompanySessionId;
  /**
   * When non-null, this orchestrator is a sub-session ("front tab") of the
   * parent. Sandbox / projects / kanban / services / env are
   * read from the parent so all sub-sessions share the same project
   * context. Board / agent_runs / master_prompts / inbox stay isolated.
   */
  readonly parentSessionId: CompanySessionId | null;
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
  /**
   * C0 — per-session autonomy config (cached; invalidated when
   * `session.config_updated` is published). Exposed for the flip phase —
   * no service consults it yet.
   */
  readonly autonomy: AutonomyProvider;

  private readonly ctx: SessionContext;
  private readonly publisher: MetaBusPublisher;
  private readonly kanban: KanbanService | null;
  private readonly board: BoardBridge;
  private readonly status: AgentStatusUpdater;
  private readonly attention: MasterAttention;
  private readonly humanInLoop: HumanInTheLoop;
  private readonly idle: IdleController;
  private readonly watchdog: IdleWatchdog;
  private readonly subordinates: SubordinateLifecycle;
  private readonly master: MasterLifecycle;
  private readonly inbox: InboxQueue;
  private readonly masterInbox: MasterInboxRouter;
  private readonly reconciler: RuntimeReconciler;
  private readonly serviceSupervisor: ServiceSupervisor;
  private readonly scheduler: CompanyScheduler | null;
  private readonly appStudioScheduler: AppStudioScheduler | null;

  constructor(opts: CompanyOrchestratorOpts) {
    this.companySessionId = asCompanySessionId(String(opts.companySessionId));
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
    this.inbox = w.inbox;
    this.masterInbox = w.masterInbox;
    this.reconciler = w.reconciler;
    this.serviceSupervisor = w.serviceSupervisor;
    this.scheduler = w.scheduler;
    this.appStudioScheduler = w.appStudioScheduler;
    this.autonomy = w.autonomy;
  }

  /**
   * Effective session id for SHARED resources (kanban, env,
   * services, drive, docs, databases, design-system). Sub-sessions resolve
   * to the parent's id so all tabs see the same project-wide artefacts.
   */
  get effectiveSessionId(): CompanySessionId { return this.ctx.effectiveSessionId; }
  get isMasterAlive(): boolean { return this.master?.isAlive ?? false; }
  /** Shared resurrect-dedup point (supervisor ↔ RuntimeReconciler). */
  masterResurrectedWithinMs(ms: number): boolean { return this.master?.resurrectedWithinMs(ms) ?? false; }
  get hasMasterStarted(): boolean { return !!this.master?.handle; }
  get masterEndedAt(): string | null { return this.master?.endedAt ?? null; }
  getMasterAgentRunId(): string | null { return this.master.agentRunId; }

  private requireCompanyKanban(): KanbanService {
    if (!this.ctx.capabilities.allowCompanyKanban || !this.kanban) {
      throw new CompanyCapabilityUnavailableError('kanban', this.ctx.runtimeKind);
    }
    return this.kanban;
  }

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
    thinkingBudgetTokens?: number;
    temperature?: number;
    /** Sticky master reasoning-effort override (orthogonal to thinking). */
    reasoningEffort?: string;
    /** Ordered explicit fallback chain; consumed only by App lifecycle. */
    fallbackModels?: import('@mcp/company/types.js').AllowedModel[];
  }): Promise<MasterStartResult> {
    // The lifecycle returns the ack as soon as the run is registered; the
    // sandbox provision + runCoder boot run in the background (so this RPC
    // stays well under its 60s deadline even on a cold container rebuild).
    return this.master.start(opts);
  }

  async resumeExistingMaster(opts: {
    userMessage: string; maxTurns?: number; roleConfigs?: RoleConfig[];
    attachments?: import('@mcp/code-agent/index.js').CoderAttachment[]; thinking?: boolean;
    provider?: string; model?: string;
    thinkingBudgetTokens?: number; temperature?: number;
    /** Sticky master reasoning-effort override (orthogonal to thinking). */
    reasoningEffort?: string;
    fallbackModels?: import('@mcp/company/types.js').AllowedModel[];
  }): Promise<MasterStartResult> {
    return this.master.resumeExisting(opts);
  }

  notifyMasterAboutSubordinate(message: string): void { this.master.notify(message); }
  /** Force the master's runner to release a pending `waitForUserInput`. */
  interruptMasterWait(info?: { kind?: 'plan' | 'question' | 'tasks'; agentRunId?: string; role?: string }): boolean {
    return this.master.handle?.runner.interruptWait(info) ?? false;
  }
  respondToMasterPlan(
    approved: boolean,
    feedback?: string,
    promptId?: string,
    deliveryOpts?: { retryOutcomeUnknown?: boolean },
  ) {
    return this.humanInLoop.respondToMasterPlan(approved, feedback, promptId, deliveryOpts);
  }
  respondToMasterQuestion(
    answer: string,
    promptId?: string,
    deliveryOpts?: { retryOutcomeUnknown?: boolean },
  ) {
    return this.humanInLoop.respondToMasterQuestion(answer, promptId, deliveryOpts);
  }
  async swapMasterProvider(providerName: string, model?: string): Promise<{ provider: string; model: string }> { return this.master.swapProvider(providerName, model); }
  updateRoleConfigs(roleConfigs: RoleConfig[]): void { this.master.updateRoleConfigs(roleConfigs); }

  /**
   * Apply a partial config patch to a running session and persist it.
   * `role_assignments` is the authoritative update path for running agents;
   * skills / allowed_models don't require a restart (consulted lazily by
   * subordinate spawns and the master's rendered roster).
   */
  async applyConfigPatch(patch: {
    role_assignments?: RoleConfig[];
    skills?: Record<string, string[]>;
    allowed_models?: import('@mcp/company/types.js').AllowedModel[];
    /** C0 — sanitized autonomy patch (shallow-merged over the persisted object). */
    autonomy?: AutonomyPatch;
  }): Promise<void> {
    const row = this.ctx.companyFiles.getSession();
    let cfg: Record<string, unknown> = {};
    try { cfg = JSON.parse(row.config_json || '{}'); } catch { cfg = {}; }
    if (patch.role_assignments) cfg.role_assignments = patch.role_assignments;
    if (patch.skills) cfg.skills = patch.skills;
    if (patch.allowed_models) cfg.allowed_models = patch.allowed_models;
    if (patch.autonomy) cfg.autonomy = mergeAutonomyPatch(cfg.autonomy, patch.autonomy);
    await this.ctx.companyFiles.updateSessionConfig(JSON.stringify(cfg));
    if (patch.role_assignments) this.master.updateRoleConfigs(patch.role_assignments);
    this.publisher.publish('session.config_updated', {
      company_session_id: this.companySessionId,
      keys: Object.keys(patch),
      at: Date.now(),
    });
  }

  async sendMessageToMaster(
    message: string,
    options: { interject?: boolean; attachments?: import('@mcp/code-agent/index.js').CoderAttachment[]; thinking?: boolean } = {},
  ): Promise<{ ok: boolean; pending?: 'interactive_wait' }> {
    // Lazy-start: sub-session's master is dormant until the first message.
    if (!this.master.isAlive && this.master.agentRunId == null) {
      const session = this.ctx.companyFiles.getSession();
      const runtime = resolveEffectiveMasterRuntime({
        configJson: session?.config_json,
        runtimeKind: session?.runtime_kind === 'app_studio' ? 'app_studio' : 'company',
      });
      let cfg: { role_assignments?: RoleConfig[] } = {};
      // The authoritative resolver above has already rejected malformed JSON.
      if (session?.config_json) cfg = JSON.parse(session.config_json) as typeof cfg;
      const opts = {
        userMessage: message,
        provider: runtime.provider,
        model: runtime.model,
        maxTurns: 100,
        roleConfigs: cfg.role_assignments ?? [],
        attachments: options.attachments,
        thinking: options.thinking ?? runtime.thinking,
        thinkingBudgetTokens: runtime.thinkingBudgetTokens,
        temperature: runtime.temperature,
        reasoningEffort: runtime.reasoningEffort,
        fallbackModels: runtime.fallbackModels,
      };
      const hasPersistedMaster = this.ctx.companyFiles
        .listAgentRunsSync()
        .some((run) => run.role === 'master');
      const launch = hasPersistedMaster
        ? this.master.resumeExisting(opts)
        : this.master.start(opts);
      // The main-side proxy cannot acknowledge delivery until the worker has
      // registered the resumed/new run. Propagate launch failure so HTTP
      // callers do not return a false 200 and permanently dedupe a lost
      // message.
      await launch;
      return { ok: true };
    }
    return this.master.sendUserMessage(message, options);
  }

  /** Rotate only the dormant Master conversation; App specialists stay live. */
  rotateMasterToPersistedSession(): boolean { return this.master.rotateToPersistedMaster(); }
  canRotateMasterConversation(): boolean { return this.master.canRotateConversation; }

  getMasterLastUserAttachments(): readonly import('@mcp/code-agent/index.js').CoderAttachment[] { return this.master.getLastUserAttachments(); }
  getRoleDefaults(role: string): ReturnType<MasterLifecycle['getRoleDefaults']> {
    // Scheduler/App dispatch can run while the Master is dormant, before its
    // in-memory roster has been hydrated. Read the persisted assignment first
    // so this facade is authoritative independently of Master lifecycle state.
    const session = this.ctx.companyFiles.getSession();
    try {
      const policy = readRoleRuntimePolicy(
        session?.config_json,
        role,
        session?.runtime_kind === 'app_studio' ? 'app_studio' : 'company',
      );
      const cfg = policy.roleConfig;
      if (cfg) {
        return {
          enabled: cfg.enabled,
          provider: cfg.provider,
          model: cfg.model,
          tier: cfg.tier,
          skills: cfg.skills,
          systemPromptOverride: cfg.systemPromptOverride,
          projectIds: cfg.projectIds,
          temperature: cfg.temperature,
          thinking: cfg.thinking,
          thinkingBudgetTokens: cfg.thinkingBudgetTokens,
          reasoningEffort: cfg.reasoningEffort,
          fallbackModels: cfg.fallbackModels,
        };
      }
    } catch {
      // Keep a running generic Company usable when a legacy config row is
      // malformed; fresh spawns still fail closed in the central resolver.
    }
    return this.master.getRoleDefaults(role);
  }
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
  async spawnSubordinate(spec: SpawnSubordinateSpec): Promise<{ agentRunId: string; coderSessionId: string; status: AgentRunStatus }> {
    return this.subordinates.spawn(spec);
  }
  async resumeSubordinate(agentRunId: string, message?: string, thinking?: boolean): Promise<{ agentRunId: string; coderSessionId: string; status: AgentRunStatus }> {
    const agentRun = this.ctx.companyFiles.getAgentRunSync(agentRunId);
    const roleOverride = agentRun ? this.master.getRoleDefaults(agentRun.role)?.systemPromptOverride : undefined;
    return this.subordinates.resume(agentRunId, message, roleOverride, undefined, thinking);
  }
  async reactivateSubordinate(agentRunId: string, message: string, attachments?: import('@mcp/code-agent/index.js').CoderAttachment[], thinking?: boolean): Promise<boolean> {
    return this.subordinates.reactivate(agentRunId, message, attachments, thinking);
  }
  abortSubordinate(agentRunId: string): boolean { return this.subordinates.abort(agentRunId); }
  /**
   * Supervisor recovery: a subordinate the DB still shows as running/waiting_*
   * whose runner is actually dead or wedged (no heartbeat). Reconcile the UI +
   * re-establish it:
   *   1. tear down any lingering (zombie) runner,
   *   2. flip the live status → 'error' so the dashboard STOPS showing "running"
   *      (and `resumeSubordinate` accepts it — it rejects a 'running' row),
   *   3. resume from the persisted coder session so it continues its task.
   * The supervisor's circuit breaker caps retries, so this can't loop forever.
   */
  async reestablishSubordinate(agentRunId: string, reason: string): Promise<{ ok: boolean; detail: string }> {
    const agentRun = this.ctx.companyFiles.getAgentRunSync(agentRunId);
    if (!agentRun) return { ok: false, detail: `agent run ${agentRunId} not found` };
    if (agentRun.role === 'master') return { ok: false, detail: 'not a subordinate' };
    try { this.subordinates.abort(agentRunId); } catch { /* best-effort zombie teardown */ }
    // Flip off the live status so the UI reflects reality AND resume is permitted.
    this.setAgentStatus(agentRunId, agentRun.role, 'error', `supervisor: ${reason}`);
    const sys =
      `[SYSTEM] Your run stalled (${reason}) and was re-established by the supervisor. ` +
      `Continue your assigned task from where you left off; if it was already done, ` +
      `post your deliverable and stop.`;
    await this.resumeSubordinate(agentRunId, sys);
    return { ok: true, detail: `re-established subordinate ${agentRunId} (${agentRun.role})` };
  }
  pauseSubordinate(agentRunId: string): boolean {
    const sub = this.subordinates.get(agentRunId);
    if (!sub) return false;
    const ok = this.subordinates.pause(agentRunId);
    // The lifecycle helper wrote the bundle projection; emit the live
    // `agent_status` (+ board) so the dashboard badge flips to "paused".
    if (ok) this.setAgentStatus(agentRunId, sub.role, 'paused', 'Paused by user');
    return ok;
  }
  getSubordinate(agentRunId: string): SubordinateHandle | undefined { return this.subordinates.get(agentRunId); }
  getSubordinateStatus(agentRunId: string): AgentRunStatus | null { return this.subordinates.statusOf(agentRunId); }
  listSubordinates() { return this.subordinates.list(); }
  /** Capacity snapshot consumed by the App-owned scheduler/dispatcher. */
  getAppDispatchCapacity(): {
    concurrencyLimit: number;
    activeConcurrent: number;
    maxSubordinates: number | null;
    activeSubordinates: number;
  } {
    return {
      concurrencyLimit: this.subordinates.concurrencyPolicy.limit,
      activeConcurrent: this.subordinates.concurrencyOccupancy,
      maxSubordinates: this.autonomy.get().maxSubordinates,
      activeSubordinates: this.ctx.companyFiles.countActiveSubordinatesAcrossCatalog(),
    };
  }
  getAppAgentRuntimeProvenance(agentRunId: string): {
    configuredProvider: string;
    configuredModel: string;
    effectiveProvider: string;
    effectiveModel: string;
    dispatchSource: import('@mcp/company/types.js').CompanyAgentDispatchSource;
    fallbackReason: string | null;
  } | null {
    const run = this.ctx.companyFiles.getAgentRunSync(agentRunId);
    if (!run || run.company_session_id !== this.companySessionId || run.role === 'master') return null;
    return {
      configuredProvider: run.configured_provider,
      configuredModel: run.configured_model,
      effectiveProvider: run.provider,
      effectiveModel: run.model,
      dispatchSource: run.dispatch_source,
      fallbackReason: run.fallback_reason,
    };
  }
  hasRunningSubordinates(): boolean { return this.subordinates.runningCount > 0; }
  /** Subscribe to master-attention events (subordinate question/plan/tasks/terminal). */
  onSubordinateAttention(listener: AttentionListener): () => void { return this.attention.on(listener); }
  isSubordinateRunning(agentRunId: string): boolean { return this.subordinates.isRunning(agentRunId); }
  /**
   * True when the master runner has buffered user messages not yet consumed.
   * `wait_for_subordinates` level-triggers off this: if a subordinate
   * notification landed while the master was mid-turn (the edge signal was
   * lost because no listener was subscribed), the master returns from the
   * wait to drain its queue instead of sleeping until the next signal.
   */
  masterHasPendingMessages(): boolean { return this.master.handle?.runner.hasPendingUserMessages() ?? false; }

  // ─── Human-in-the-loop resolvers ───────────────────────────────
  resolveSubordinatePlan(agentRunId: string, approved: boolean, feedback?: string): boolean { return this.humanInLoop.resolvePlan(agentRunId, approved, feedback); }
  resolveSubordinateQuestion(agentRunId: string, answer: string): boolean { return this.humanInLoop.resolveQuestion(agentRunId, answer); }
  resolveSubordinateTasks(agentRunId: string, approved: boolean, feedback?: string, executionMode?: string): boolean { return this.humanInLoop.resolveTasks(agentRunId, approved, feedback, executionMode); }
  hasPendingPlan(agentRunId: string): boolean { return this.humanInLoop.hasPendingPlan(agentRunId); }
  hasPendingQuestion(agentRunId: string): boolean { return this.humanInLoop.hasPendingQuestion(agentRunId); }
  hasPendingTasks(agentRunId: string): boolean { return this.humanInLoop.hasPendingTasks(agentRunId); }
  /** B7 — latest plan approval for an agent run (QA plan gate). Null = no approved plan. */
  hasApprovedPlan(agentRunId: string): { approved: boolean; auto: boolean } | null { return this.humanInLoop.hasApprovedPlan(agentRunId); }
  /**
   * B7 — raw `config_json` of this session ('' when unavailable). Read-only
   * accessor for tools that need per-role metadata (e.g. the QA plan gate
   * checks the caller's skills) without widening the orchestrator surface
   * with bespoke queries.
   */
  getSessionConfigJson(): string {
    try {
      return this.ctx.companyFiles.getSession().config_json;
    } catch {
      return '';
    }
  }

  // ─── Board ─────────────────────────────────────────────────────
  postToBoard(authorRole: string, agentRunId: string | null, kind: 'message' | 'decision' | 'question' | 'deliverable' | 'handoff' | 'blocker', content: string, mentions?: string[]): void {
    this.board.post(authorRole, agentRunId, kind, content, mentions);
  }
  async readBoard(opts?: ReadBoardOptions): Promise<BoardEntry[]> {
    return readBoardWithWatermarks(this.board, this.ctx, this.companySessionId, opts);
  }

  // ─── Kanban ────────────────────────────────────────────────────
  kanbanCreateCard(input: Parameters<KanbanService['createCard']>[0]): KanbanCardFull { return this.requireCompanyKanban().createCard(input); }
  kanbanMoveCard(cardId: string, column: KanbanColumn, position?: number): KanbanCard { return this.requireCompanyKanban().moveCard(cardId, column, position); }
  kanbanUpdateCard(cardId: string, patch: { title?: string; description?: string; tag?: KanbanTag | null }): KanbanCard | null { return this.requireCompanyKanban().updateCard(cardId, patch); }
  kanbanDeleteCard(cardId: string): boolean { return this.requireCompanyKanban().deleteCard(cardId); }
  kanbanAddComment(cardId: string, authorRole: string, agentRunId: string | null, content: string): KanbanComment { return this.requireCompanyKanban().addComment(cardId, authorRole, agentRunId, content); }
  kanbanUpdateChecklist(cardId: string, items: Array<{ id?: string; text: string; checked: boolean }>): KanbanChecklistItem[] { return this.requireCompanyKanban().updateChecklist(cardId, items); }
  kanbanAddDependency(cardId: string, dependsOnId: string): KanbanCardDependency { return this.requireCompanyKanban().addDependency(cardId, dependsOnId); }
  kanbanRemoveDependency(cardId: string, dependsOnId: string): boolean { return this.requireCompanyKanban().removeDependency(cardId, dependsOnId); }
  kanbanAssignAgent(cardId: string, agentRunId: string, role: string): KanbanCardAgent { return this.requireCompanyKanban().assignAgent(cardId, agentRunId, role); }
  kanbanUnassignAgent(cardId: string, agentRunId: string): void { this.requireCompanyKanban().unassignAgent(cardId, agentRunId); }
  kanbanListCards(opts?: { column?: KanbanColumn }): KanbanCard[] { return this.kanban?.listCards(opts) ?? []; }
  kanbanGetCard(cardId: string): KanbanCardFull | null { return this.kanban?.getCard(cardId) ?? null; }
  kanbanListCardsFull(): KanbanCardFull[] { return this.kanban?.listCardsFull() ?? []; }
  /**
   * C3 — manual dispatch of one card ("quick-dispatch" route / suggestion
   * chip). Same recommend→spawn→assign→move→comment unit the autonomous
   * scheduler uses; an explicit `role` skips the recommender entirely.
   */
  async dispatchCard(cardId: string, role?: string): Promise<DispatchCardResult> {
    const kanban = this.requireCompanyKanban();
    return dispatchCard(
      {
        sessionId: this.companySessionId,
        kanban,
        subordinates: this.subordinates,
        recommend: getGlobalCompanyRecommend(),
        publish: (event, data) => this.publisher.publish(event, data),
      },
      cardId,
      { role, source: 'manual' },
    );
  }
  findCardForAgent(agentRunId: string): string | null { return this.kanban?.findCardForAgent(agentRunId) ?? null; }
  getCardContextForSubordinate(cardId: string): string { return this.kanban?.getCardContextForSubordinate(cardId) ?? ''; }

  // ─── Projects / status ─────────────────────────────────────────
  listProjects() {
    return this.ctx.projects.map((p) => {
      const proj = this.ctx.db.getProject(p.project_id);
      return { id: p.project_id, name: proj?.name ?? `project-${p.project_id}`, rootPath: proj?.root_path ?? '', label: p.label };
    });
  }
  setAgentStatus(agentRunId: string, role: string, status: string, message: string): void {
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
  /**
   * MessagePort-safe projection for the main-process service route.
   * `SandboxBinding` itself contains an `ISandboxDriver` with functions and
   * therefore cannot be structured-cloned out of the company worker.
   */
  async addSandboxService(
    opts: Omit<Parameters<SandboxService['addService']>[0], 'signal'>,
  ): Promise<{ previewUrl: string; containerId: string }> {
    const binding = await this.sandboxService.addService(opts);
    return {
      previewUrl: binding.previewUrl,
      containerId: binding.containerId,
    };
  }
  async removeSandboxService(serviceId: string): Promise<void> {
    await this.sandboxService.removeService(serviceId);
  }

  // ─── Shutdown ──────────────────────────────────────────────────
  async abortAll(
    opts: { teardownSandbox?: boolean; finalStatus?: 'error' | 'idle' } = {},
  ): Promise<void> {
    const teardownSandbox = opts.teardownSandbox ?? true;
    const finalStatus = opts.finalStatus ?? 'error';
    this.ctx.markAborted();
    this.idle.clear();
    this.watchdog.dispose();
    this.reconciler.stop();
    this.serviceSupervisor.stop();
    this.scheduler?.stop();
    this.appStudioScheduler?.stop();
    this.subordinates.abortAll();
    this.master.abort();
    await this.humanInLoop.cancelPendingMasterPrompts().catch(() => undefined);
    await this.ctx.companyFiles.updateSessionStatus(finalStatus);
    // Sub-sessions don't own a sandbox — teardown would target the parent's
    // container, which siblings still depend on.
    if (teardownSandbox && this.parentSessionId == null) {
      // Destructive callers await the worker RPC before evicting it. Keeping
      // teardown inside that acknowledgement prevents the worker from exiting
      // midway through container removal and leaving an orphan sandbox.
      await this.sandboxService.teardown('aborted').catch(() => void 0);
    }
    this.publisher.markEnded('done', { reason: 'aborted' });
  }
  async finalizeAllSubordinates(): Promise<{ finalized: number; alreadyStopped: number }> {
    // Fence idle/subordinate-change observers before finalizeAll emits any
    // status transitions. Otherwise an observer can enqueue `paused` while
    // this explicit terminal decision is still being persisted.
    this.ctx.markFinalized();
    const result = this.subordinates.finalizeAll();
    await this.ctx.companyFiles.updateSessionStatus('completed');
    return result;
  }
  /** Mem C — distill board decisions/blockers/deliverables into per-project
   *  memory snapshots. Fired (fire-and-forget) by `finalize_subordinates`;
   *  best-effort and semantically deduped, so a double call is harmless. */
  consolidateMemory(): Promise<{ projects: number; entries: number }> {
    return consolidateBoardToMemory({
      companySessionId: this.companySessionId,
      companyFiles: this.ctx.companyFiles,
      db: this.ctx.db,
      projects: this.ctx.projects,
    });
  }

  // ─── Agent inbox ───────────────────────────────────────────────
  inboxSend(args: InboxSendArgs): InboxSendResult { return this.inbox.send(args); }
  inboxRespond(messageId: string, answer: string): boolean { return this.inbox.respond(messageId, answer); }
  /** C9 — Async send poll. `check_inbox_answer` calls this to poll a fire-and-forget message. */
  inboxStatus(messageId: string): { status: InboxStatus; answer: string | null; deliveredAt: string | null; answeredAt: string | null } | null { return this.inbox.getMessageStatus(messageId); }
  inboxCancel(messageId: string, reason: string): boolean { return this.inbox.cancel(messageId, reason); }
  inboxList(opts?: { status?: InboxStatus | InboxStatus[]; toRole?: string; toAgentRunId?: string; fromAgentRunId?: string; limit?: number }): AgentInboxMessage[] {
    return this.inbox.list(opts ?? {});
  }
  /** Block until the inbox message identified by `waitToken` is answered. */
  inboxWait(waitToken: string, timeoutMs?: number): Promise<string> { return this.inbox.waitForAnswer(waitToken, timeoutMs); }
  inboxDetectCycle(args: { fromAgentRunId: string; toRole?: string; toAgentRunId?: string }): boolean { return this.inbox.detectCycle(args); }
  /** Manually flush pending master inbox messages — boot-time and after rehydration. */
  revivePendingMasters(): void { this.masterInbox.reviveIfPending(); }
}
