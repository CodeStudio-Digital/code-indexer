import type { MasterStartResult } from '@mcp/code-agent/index/types.js';
import type { QaRunCompletedPayload } from './tools/qa/qa-event-types.js';
import type { CompanySessionId } from '@mcp/session-storage';
import type { AgentRunStatus, BoardEntry, KanbanCard, KanbanCardAgent, KanbanCardDependency, KanbanCardFull, KanbanChecklistItem, KanbanColumn, KanbanComment, KanbanTag, SubordinateHandle } from '@mcp/company/types.js';
import type { AgentInboxMessage, InboxStatus, SandboxBinding } from '@mcp/company/types.js';
import type { KanbanService } from './services/KanbanService.js';
import type { SpawnSubordinateSpec } from './services/subordinate/spec.js';
import type { RoleConfig } from './services/master/role-config.js';
import type { AttentionListener } from './services/MasterAttention.js';
import type { SandboxService } from './services/SandboxService.js';
import type { SendArgs as InboxSendArgs, SendResult as InboxSendResult } from './services/inbox-message-types.js';
import type { DispatchCardResult } from './services/scheduler/dispatch-card.js';
import type { CompanyDriveStore } from './services/CompanyDriveStore.js';
import type { CompanyEventBus } from './services/CompanyEventBus.js';
import type { AutonomyProvider } from './services/autonomy/autonomy-provider.js';
import type { AutonomyPatch } from './services/autonomy/autonomy-patch.js';
import type { SandboxPeer } from './orchestrator/sandbox-helpers.js';
import type { ReadBoardOptions } from './orchestrator/board-helpers.js';
import type { AllowedModel, RoleSkills, MasterPrompt } from '@mcp/company/types.js';

/** Public orchestration capability used by tools and runtime contexts. */
export interface CompanyOrchestratorPort {
  readonly companySessionId: CompanySessionId;
  readonly parentSessionId: CompanySessionId | null;
  publishQaResult(payload: QaRunCompletedPayload): void;
  readonly sandboxService: SandboxService;
  readonly eventBus: CompanyEventBus;
  readonly driveStore: CompanyDriveStore;
  readonly autonomy: AutonomyProvider;
  readonly effectiveSessionId: CompanySessionId;
  readonly isMasterAlive: boolean;
  /** Shared resurrect-dedup point (supervisor ↔ RuntimeReconciler). */
  masterResurrectedWithinMs(ms: number): boolean;
  readonly hasMasterStarted: boolean;
  readonly masterEndedAt: string | null;
  getMasterAgentRunId(): string | null;
  getMasterStatus(): Promise<{
      alive: boolean;
      endedAt: string | null;
  }>;
  tryDeliverMasterInboxNow(): Promise<void>;
  startMaster(opts: {
      userMessage: string;
      provider: string;
      model: string;
      maxTurns?: number;
      signal?: AbortSignal;
      roleConfigs?: RoleConfig[];
      attachments?: import('@mcp/code-agent/index/types.js').CoderAttachment[];
      boardAttachments?: import('@mcp/company-contracts').BoardAttachment[];
      thinking?: boolean;
      thinkingBudgetTokens?: number;
      temperature?: number;
      /** Sticky master reasoning-effort override (orthogonal to thinking). */
      reasoningEffort?: string;
      /** Ordered explicit fallback chain; consumed only by App lifecycle. */
      fallbackModels?: import('@mcp/company/types.js').AllowedModel[];
  }): Promise<MasterStartResult>;
  resumeExistingMaster(opts: {
      recordUserMessage?: boolean;
      userMessage: string;
      maxTurns?: number;
      roleConfigs?: RoleConfig[];
      attachments?: import('@mcp/code-agent/index/types.js').CoderAttachment[];
      boardAttachments?: import('@mcp/company-contracts').BoardAttachment[];
      thinking?: boolean;
      provider?: string;
      model?: string;
      thinkingBudgetTokens?: number;
      temperature?: number;
      /** Sticky master reasoning-effort override (orthogonal to thinking). */
      reasoningEffort?: string;
      fallbackModels?: import('@mcp/company/types.js').AllowedModel[];
  }): Promise<MasterStartResult>;
  notifyMasterAboutSubordinate(message: string): void;
  /** Force the master's runner to release a pending `waitForUserInput`. */
  interruptMasterWait(info?: {
      kind?: 'plan' | 'question' | 'tasks';
      agentRunId?: string;
      role?: string;
  }): boolean;
  respondToMasterPlan(approved: boolean, feedback?: string, promptId?: string, deliveryOpts?: {
      retryOutcomeUnknown?: boolean;
  }): Promise<MasterPrompt | null>;
  respondToMasterQuestion(answer: string, promptId?: string, deliveryOpts?: {
      retryOutcomeUnknown?: boolean;
  }): Promise<MasterPrompt | null>;
  swapMasterProvider(providerName: string, model?: string): Promise<{
      provider: string;
      model: string;
  }>;
  updateRoleConfigs(roleConfigs: RoleConfig[]): void;
  applyConfigPatch(patch: {
      role_assignments?: RoleConfig[];
      skills?: Record<string, string[]>;
      allowed_models?: import('@mcp/company/types.js').AllowedModel[];
      /** C0 — sanitized autonomy patch (shallow-merged over the persisted object). */
      autonomy?: AutonomyPatch;
  }): Promise<void>;
  sendMessageToMaster(message: string, options?: {
      interject?: boolean;
      attachments?: import('@mcp/code-agent/index/types.js').CoderAttachment[];
      boardAttachments?: import('@mcp/company-contracts').BoardAttachment[];
      thinking?: boolean;
  }): Promise<{
      ok: boolean;
      pending?: 'interactive_wait';
  }>;
  /** Rotate only the dormant Master conversation; App specialists stay live. */
  rotateMasterToPersistedSession(): boolean;
  canRotateMasterConversation(): boolean;
  getMasterLastUserAttachments(): readonly import('@mcp/code-agent/index/types.js').CoderAttachment[];
  getRoleDefaults(role: string): {
      enabled?: boolean;
      provider?: string;
      model?: string;
      tier?: string;
      skills?: RoleSkills;
      initialTools?: string[];
      systemPromptOverride?: string;
      projectIds?: number[];
      temperature?: number;
      thinking?: boolean;
      thinkingBudgetTokens?: number;
      reasoningEffort?: string;
      fallbackModels?: AllowedModel[];
  } | null;
  /** Project-first view: roles bound to `projectId` via `CompanyRoleConfig.projectIds`. */
  getRolesForProject(projectId: number): string[];
  getProjectIdsForRole(role: string): number[];
  getAllowedModels(): readonly import('@mcp/company/types.js').AllowedModel[];
  getPoolDefault(): import('@mcp/company/types.js').AllowedModel | null;
  spawnSubordinate(spec: SpawnSubordinateSpec): Promise<{
      agentRunId: string;
      coderSessionId: string;
      status: AgentRunStatus;
  }>;
  resumeSubordinate(agentRunId: string, message?: string, thinking?: boolean): Promise<{
      agentRunId: string;
      coderSessionId: string;
      status: AgentRunStatus;
  }>;
  reactivateSubordinate(agentRunId: string, message: string, attachments?: import('@mcp/code-agent/index/types.js').CoderAttachment[], thinking?: boolean): Promise<boolean>;
  abortSubordinate(agentRunId: string): boolean;
  reestablishSubordinate(agentRunId: string, reason: string): Promise<{
      ok: boolean;
      detail: string;
  }>;
  pauseSubordinate(agentRunId: string): boolean;
  getSubordinate(agentRunId: string): SubordinateHandle | undefined;
  getSubordinateStatus(agentRunId: string): AgentRunStatus | null;
  listSubordinates(): Array<{
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
  }>;
  /** Capacity snapshot consumed by the App-owned scheduler/dispatcher. */
  getAppDispatchCapacity(): {
      concurrencyLimit: number;
      activeConcurrent: number;
      maxSubordinates: number | null;
      activeSubordinates: number;
  };
  getAppAgentRuntimeProvenance(agentRunId: string): {
      configuredProvider: string;
      configuredModel: string;
      effectiveProvider: string;
      effectiveModel: string;
      dispatchSource: import('@mcp/company/types.js').CompanyAgentDispatchSource;
      fallbackReason: string | null;
  } | null;
  hasRunningSubordinates(): boolean;
  /** Subscribe to master-attention events (subordinate question/plan/tasks/terminal). */
  onSubordinateAttention(listener: AttentionListener): () => void;
  isSubordinateRunning(agentRunId: string): boolean;
  /**
   * True when the master runner has buffered user messages not yet consumed.
   * `wait_for_subordinates` level-triggers off this: if a subordinate
   * notification landed while the master was mid-turn (the edge signal was
   * lost because no listener was subscribed), the master returns from the
   * wait to drain its queue instead of sleeping until the next signal.
   */
  masterHasPendingMessages(): boolean;
  // ─── Human-in-the-loop resolvers ───────────────────────────────
  resolveSubordinatePlan(agentRunId: string, approved: boolean, feedback?: string): boolean;
  resolveSubordinateQuestion(agentRunId: string, answer: string): boolean;
  resolveSubordinateTasks(agentRunId: string, approved: boolean, feedback?: string, executionMode?: string): boolean;
  hasPendingPlan(agentRunId: string): boolean;
  hasPendingQuestion(agentRunId: string): boolean;
  hasPendingTasks(agentRunId: string): boolean;
  /** B7 — latest plan approval for an agent run (QA plan gate). Null = no approved plan. */
  hasApprovedPlan(agentRunId: string): {
      approved: boolean;
      auto: boolean;
  } | null;
  /**
   * B7 — raw `config_json` of this session ('' when unavailable). Read-only
   * accessor for tools that need per-role metadata (e.g. the QA plan gate
   * checks the caller's skills) without widening the orchestrator surface
   * with bespoke queries.
   */
  getSessionConfigJson(): string;
  // ─── Board ─────────────────────────────────────────────────────
  postToBoard(authorRole: string, agentRunId: string | null, kind: 'message' | 'decision' | 'question' | 'deliverable' | 'handoff' | 'blocker', content: string, mentions?: string[]): void;
  readBoard(opts?: ReadBoardOptions): Promise<BoardEntry[]>;
  // ─── Kanban ────────────────────────────────────────────────────
  kanbanCreateCard(input: Parameters<KanbanService['createCard']>[0]): KanbanCardFull;
  kanbanMoveCard(cardId: string, column: KanbanColumn, position?: number): KanbanCard;
  kanbanUpdateCard(cardId: string, patch: {
      title?: string;
      description?: string;
      tag?: KanbanTag | null;
  }): KanbanCard | null;
  kanbanDeleteCard(cardId: string): boolean;
  kanbanAddComment(cardId: string, authorRole: string, agentRunId: string | null, content: string): KanbanComment;
  kanbanUpdateChecklist(cardId: string, items: Array<{
      id?: string;
      text: string;
      checked: boolean;
  }>): KanbanChecklistItem[];
  kanbanAddDependency(cardId: string, dependsOnId: string): KanbanCardDependency;
  kanbanRemoveDependency(cardId: string, dependsOnId: string): boolean;
  kanbanAssignAgent(cardId: string, agentRunId: string, role: string): KanbanCardAgent;
  kanbanUnassignAgent(cardId: string, agentRunId: string): void;
  kanbanListCards(opts?: {
      column?: KanbanColumn;
  }): KanbanCard[];
  kanbanGetCard(cardId: string): KanbanCardFull | null;
  kanbanListCardsFull(): KanbanCardFull[];
  dispatchCard(cardId: string, role?: string): Promise<DispatchCardResult>;
  findCardForAgent(agentRunId: string): string | null;
  getCardContextForSubordinate(cardId: string): string;
  // ─── Projects / status ─────────────────────────────────────────
  listProjects(): Array<{
      id: number;
      name: string;
      rootPath: string;
      label: string | null;
  }>;
  setAgentStatus(agentRunId: string, role: string, status: string, message: string): void;
  // ─── Sandbox ───────────────────────────────────────────────────
  getSandboxBinding(): SandboxBinding | null;
  getSandboxServiceBinding(serviceId: string): SandboxBinding | null;
  getSandboxStackForService(serviceId?: string | null): string | null;
  listSandboxPeers(selfServiceId?: string | null): SandboxPeer[];
  provisionSandboxIfNeeded(signal?: AbortSignal): Promise<SandboxBinding | null>;
  addSandboxService(opts: Omit<Parameters<SandboxService['addService']>[0], 'signal'>): Promise<{
      previewUrl: string;
      containerId: string;
  }>;
  removeSandboxService(serviceId: string): Promise<void>;
  abortAll(opts?: {
      teardownSandbox?: boolean;
      finalStatus?: 'error' | 'idle' | 'paused';
  }): Promise<void>;
  finalizeAllSubordinates(): Promise<{
      finalized: number;
      alreadyStopped: number;
  }>;
  /** Mem C — distill board decisions/blockers/deliverables into per-project
   *  memory snapshots. Fired (fire-and-forget) by `finalize_subordinates`;
   *  best-effort and semantically deduped, so a double call is harmless. */
  consolidateMemory(): Promise<{
      projects: number;
      entries: number;
  }>;
  // ─── Agent inbox ───────────────────────────────────────────────
  inboxSend(args: InboxSendArgs): InboxSendResult;
  inboxRespond(messageId: string, answer: string): boolean;
  /** C9 — Async send poll. `check_inbox_answer` calls this to poll a fire-and-forget message. */
  inboxStatus(messageId: string): {
      status: InboxStatus;
      answer: string | null;
      deliveredAt: string | null;
      answeredAt: string | null;
  } | null;
  inboxCancel(messageId: string, reason: string): boolean;
  inboxList(opts?: {
      status?: InboxStatus | InboxStatus[];
      toRole?: string;
      toAgentRunId?: string;
      fromAgentRunId?: string;
      limit?: number;
  }): AgentInboxMessage[];
  /** Block until the inbox message identified by `waitToken` is answered. */
  inboxWait(waitToken: string, timeoutMs?: number): Promise<string>;
  inboxDetectCycle(args: {
      fromAgentRunId: string;
      toRole?: string;
      toAgentRunId?: string;
  }): boolean;
  /** Manually flush pending master inbox messages — boot-time and after rehydration. */
  revivePendingMasters(): void;
}
