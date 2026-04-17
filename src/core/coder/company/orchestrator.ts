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
  // These four have a small construction cycle (Master ↔ HumanInTheLoop,
  // Subordinates ↔ Idle); they're assigned inside the constructor body.
  private readonly humanInLoop!: HumanInTheLoop;
  private readonly idle!: IdleController;
  private readonly subordinates!: SubordinateLifecycle;
  private readonly master!: MasterLifecycle;

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
    this.kanban = new KanbanService(this.ctx, this.publisher);
    this.board = new BoardBridge(this.ctx, this.publisher, this.kanban);
    this.status = new AgentStatusUpdater(this.ctx, this.publisher);

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

    const humanInLoop = new HumanInTheLoop(this.publisher, this.board, this.status, master);
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

  respondToMasterPlan(approved: boolean, feedback?: string): boolean {
    return this.humanInLoop.respondToMasterPlan(approved, feedback);
  }

  respondToMasterQuestion(answer: string): boolean {
    return this.humanInLoop.respondToMasterQuestion(answer);
  }

  async swapMasterProvider(providerName: string, model?: string): Promise<{ provider: string; model: string }> {
    return this.master.swapProvider(providerName, model);
  }

  updateRoleConfigs(roleConfigs: RoleConfig[]): void {
    this.master.updateRoleConfigs(roleConfigs);
  }

  sendMessageToMaster(message: string): boolean {
    return this.master.sendUserMessage(message);
  }

  getRoleDefaults(role: string): { provider?: string; model?: string; tier?: string; skills?: string[] } | null {
    return this.master.getRoleDefaults(role);
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
    return this.subordinates.resume(agentRunId, message);
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

  abortAll(): void {
    this.ctx.markAborted();
    this.idle.clear();
    this.subordinates.abortAll();
    this.master.abort();
    try {
      this.ctx.companyStore.updateCompanySessionStatus(this.companySessionId, 'error');
    } catch { /* ignore */ }
    this.publisher.markEnded('done', { reason: 'aborted' });
  }

  finalizeAllSubordinates(): { finalized: number; alreadyStopped: number } {
    return this.subordinates.finalizeAll();
  }
}
