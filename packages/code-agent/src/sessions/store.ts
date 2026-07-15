/**
 * SessionStore wraps the SQLite tables added by migration 004.
 *
 * Public API. Bodies live in `./store/` sub-modules so this file stays under
 * the 250-LOC ceiling. The runner persists each turn (assistant message +
 * tool calls + tool results) atomically via `persistAssistantTurn`.
 */
import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import type { ToolOutputCapLevel } from '@mcp/code-agent/core/runner/output-caps.js';
import type {
  CoderMessageRow,
  CoderPlanRow,
  CoderPlanStatus,
  CoderSession,
  CoderSessionGroup,
  CoderSessionStats,
  CoderTask,
  CoderTasksRow,
  RecentCoderSession,
  GlobalCoderSession,
  LinkedProject,
  SessionInputRow,
  SessionWithMessages,
  TaskExecutionMode,
  TasksState,
  CommitConversationChapterInput,
  CommitConversationChapterResult,
  ConversationChapterPage,
  ConversationChapterRow,
  ConversationChapterSearchResult,
  ConversationChapterSource,
  InsertRebuiltConversationChaptersResult,
  RebuiltConversationChapterInput,
  ConversationChapterStatus,
  FinishCompactionAttemptInput,
  StartCompactionAttemptInput,
  ExternalSessionSource,
  ImportExternalSessionResult,
  PersistExternalSessionInput,
} from '@mcp/code-agent/sessions/types.js';

import * as core from './store/sessions-core.js';
import * as sessionProjects from './store/session-projects.js';
import * as state from './store/sessions-state.js';
import * as ops from './store/sessions-ops.js';
import * as goals from './store/goals.js';
import * as messages from './store/messages.js';
import * as toolResults from './store/tool-results.js';
import * as plans from './store/plans.js';
import * as inputs from './store/inputs.js';
import * as sessionDrive from './store/session-drive.js';
import * as tasks from './store/tasks.js';
import * as taskRuns from './store/task-runs.js';
import * as toolStats from './store/tool-stats.js';
import * as groups from './store/groups.js';
import * as disabledTools from './store/disabled-tools.js';
import * as telemetryRecord from './store/telemetry-record.js';
import * as telemetryPayload from './store/telemetry-payload.js';
import * as telemetrySession from './store/telemetry-session.js';
import * as telemetryGlobal from './store/telemetry-global.js';
import * as telemetryBackfill from './store/telemetry-backfill.js';
import * as subagentTelemetry from './store/subagent-telemetry.js';
import * as subagentRecommendations from './store/subagent-recommendations.js';
import * as chapters from './store/chapters.js';
import * as compactionAttempts from './store/compaction-attempts.js';
import * as sessionImports from './store/imports.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;

export class SessionStore {
  private db: DB;
  /** True only when this store opened the file itself (string ctor). A
   *  SHARED handle is owned by CodeIndexDB — closing it here would yank the
   *  connection out from under every sibling store. */
  private readonly ownsHandle: boolean;

  constructor(dbPathOrHandle: string | DB) {
    if (typeof dbPathOrHandle === 'string') {
      this.db = new Database(dbPathOrHandle);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.ownsHandle = true;
    } else {
      // Shared handle (CodeIndexDB.raw()): pragmas (WAL + foreign_keys=ON)
      // are already set by the owner. Re-opening the file — what this ctor
      // used to do unconditionally — created a 2nd writer on the same file
      // and serialized every session read behind WAL lock contention.
      this.db = dbPathOrHandle;
      this.ownsHandle = false;
    }
  }

  close(): void { if (this.ownsHandle) this.db.close(); }
  /** Escape hatch for sibling stores on the same SQLite file. */
  getDb(): DB { return this.db; }

  // ─── Sessions CRUD ─────────────────────────────────────────────
  // NOTE: sessions (coder_sessions/messages/tool_calls/plans/tasks) stay CENTRAL
  // by design — the per-project DB split covers index + API client + project
  // features, NOT session runtime (keeps the chat core untouched + platform
  // usage stats faithful).
  createSession(input: core.CreateSessionInput): CoderSession { return core.create(this.db, input); }
  getSession(id: number): CoderSession | null { return core.get(this.db, id); }
  getLastUsedProviderModel(): core.LastUsedProviderModel | null { return core.getLastUsedProviderModel(this.db); }
  listSessions(projectId: number, opts: { archived?: boolean | null; groupId?: number | null } = {}): CoderSession[] { return core.list(this.db, projectId, opts); }
  listRecentSessionsGlobal(limit = 10): RecentCoderSession[] { return core.listRecentGlobal(this.db, limit); }
  findImportedSession(projectId: number, source: ExternalSessionSource, externalId: string): number | null {
    return sessionImports.findImported(this.db, projectId, source, externalId);
  }
  importExternalSession(input: PersistExternalSessionInput): ImportExternalSessionResult {
    return sessionImports.persist(this.db, input);
  }

  // ─── Global (multi-project) sessions (migration 152) ───────────
  createGlobalSession(input: core.CreateGlobalSessionInput): CoderSession { return core.createGlobal(this.db, input); }
  listGlobalSessions(opts: { archived?: boolean | null } = {}): GlobalCoderSession[] { return core.listGlobal(this.db, opts); }
  /** Linked projects (enriched with name + root) for a session. Empty for non-global sessions. */
  getSessionProjects(sessionId: number): LinkedProject[] { return sessionProjects.listLinked(this.db, sessionId); }
  linkSessionProject(sessionId: number, projectId: number, opts: { label?: string | null; isPrimary?: boolean } = {}): void { sessionProjects.add(this.db, sessionId, projectId, opts); }
  unlinkSessionProject(sessionId: number, projectId: number): void { sessionProjects.remove(this.db, sessionId, projectId); }
  /** Count sessions referencing a project — refcount for synthetic global workspaces. */
  countSessionsForProject(projectId: number): number { return core.countSessionsForProject(this.db, projectId); }
  /** Canonical real-project links of a synthetic union (from any sibling session). */
  listUnionProjects(syntheticProjectId: number): LinkedProject[] { return core.listUnionProjects(this.db, syntheticProjectId); }
  deleteSession(id: number): void { core.del(this.db, id); }
  deleteSessionsBatch(ids: number[]): number { return core.delBatch(this.db, ids); }
  recoverStaleSessions(): number { return core.recoverStale(this.db); }
  /**
   * Frente E — periodic watchdog hook. Recovers ONLY sessions whose
   * `updated_at` is older than `maxAgeMs` (default 10 min). The boot
   * sweep above is broader (it touches every active row); this one is
   * safe to call repeatedly at runtime without disrupting healthy runs.
   */
  recoverStuckRunningSessions(opts: { maxAgeMs?: number } = {}): number {
    return core.recoverStuckRunning(this.db, opts);
  }

  // ─── Sessions state (set*) ─────────────────────────────────────
  setSessionAgent(id: number, agent: string | null): void { state.setAgent(this.db, id, agent); }
  setSessionTemperature(id: number, temperature: number | null): void { state.setTemperature(this.db, id, temperature); }
  setSessionReasoningEffort(id: number, effort: string | null): void { state.setReasoningEffort(this.db, id, effort); }
  setSessionThinkingEnabled(id: number, enabled: boolean): void { state.setThinkingEnabled(this.db, id, enabled); }
  setSessionPlanDepth(id: number, depth: string | null): void { state.setPlanDepth(this.db, id, depth); }
  setSessionResponseLanguage(id: number, language: string | null): void { state.setResponseLanguage(this.db, id, language); }
  setSessionOutputStyle(id: number, style: string | null): void { state.setOutputStyle(this.db, id, style); }
  setSessionPreflightSeed(id: number, seedJson: string | null): void { state.setPreflightSeed(this.db, id, seedJson); }
  setSessionUnrestrictedToolOutput(id: number, enabled: boolean | null): void { state.setUnrestrictedToolOutput(this.db, id, enabled); }
  setSessionToolOutputCapLevel(id: number, level: ToolOutputCapLevel | null): void { state.setToolOutputCapLevel(this.db, id, level); }
  setSessionToolPermissionMode(id: number, mode: 'ask' | 'auto' | 'unrestricted' | null): void { state.setToolPermissionMode(this.db, id, mode); }
  addToolPermissionGrant(id: number, toolName: string): void { state.addToolPermissionGrant(this.db, id, toolName); }
  setSessionToolProfile(id: number, profile: 'bootstrap' | 'navigate' | 'full'): void { state.setToolProfile(this.db, id, profile); }
  mergeSessionToolsetState(id: number, patch: { addExtraTiers?: readonly string[]; addPins?: readonly string[]; visibleCap?: number | null }): void { state.mergeToolsetState(this.db, id, patch); }
  touchSession(id: number): void { state.touchSession(this.db, id); }
  setLastResponseState(id: number, responseId: string | null, messageCount: number | null): void { state.setLastResponseState(this.db, id, responseId, messageCount); }
  setSessionArchived(id: number, archived: boolean): void { state.setArchived(this.db, id, archived); }
  setSessionFavorite(id: number, favorite: boolean): void { state.setFavorite(this.db, id, favorite); }
  setSessionTitle(id: number, title: string): void { state.setTitle(this.db, id, title); }
  setSessionGroup(id: number, groupId: number | null): void { state.setGroup(this.db, id, groupId); }
  setSessionTodos(id: number, todosJson: string | null): void { state.setTodos(this.db, id, todosJson); }
  setSessionWorktree(id: number, worktreePath: string | null): void { state.setWorktree(this.db, id, worktreePath); }
  getOrCreateCloudCodeSessionId(id: number): string { return state.getOrCreateCloudCodeSessionId(this.db, id); }
  updateSessionStatus(id: number, status: CoderSession['status']): void { state.updateStatus(this.db, id, status); }
  updateSessionProvider(id: number, provider: string, model: string): void { state.updateProvider(this.db, id, provider, model); }
  getSessionFallback(id: number): { provider: string; model: string } | null { return state.getFallback(this.db, id); }
  setSessionFallback(id: number, provider: string | null, model: string | null): void { state.setFallback(this.db, id, provider, model); }
  bumpUsage(id: number, inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheCreationTokens = 0): void {
    state.bumpUsage(this.db, id, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens);
  }
  setSessionBaseCommit(sessionId: number, sha: string | null): void { state.setBaseCommit(this.db, sessionId, sha); }
  markSessionReviewedNow(sessionId: number): void { state.markReviewedNow(this.db, sessionId); }
  setMemoryDistilledBoundary(id: number, messageId: number): void { state.setMemoryDistilledBoundary(this.db, id, messageId); }
  getMemoryDistilledBoundary(id: number): number { return state.getMemoryDistilledBoundary(this.db, id); }
  bumpMemoryDistillAttempts(id: number): void { state.bumpMemoryDistillAttempts(this.db, id); }
  resetMemoryDistillAttempts(id: number): void { state.resetMemoryDistillAttempts(this.db, id); }

  // ─── Sessions ops (stats, fork, duplicate) ─────────────────────
  getSessionStats(id: number): CoderSessionStats | null { return ops.getStats(this.db, id); }
  listMemoryDistillPending(idleSeconds: number, limit: number): ops.MemoryDistillPendingRow[] {
    return ops.listMemoryDistillPending(this.db, idleSeconds, limit);
  }
  forkSessionBeforeMessage(sourceSessionId: number, beforeMessageId: number): { session: CoderSession; seed_text: string } {
    return ops.forkBeforeMessage(this.db, sourceSessionId, beforeMessageId);
  }
  /** Destructive: delete `messageId` + everything after it, returning its text
   *  and attachments to seed the composer. See `ops.rollbackToMessage`. */
  rollbackSessionToMessage(sessionId: number, messageId: number): ops.RollbackResult {
    return ops.rollbackToMessage(this.db, sessionId, messageId);
  }
  duplicateSession(sourceId: number): CoderSession { return ops.duplicate(this.db, sourceId); }

  // ─── Session goal (migration 068) ──────────────────────────────
  getSessionGoal(id: number): goals.SessionGoal | null { return goals.get(this.db, id); }
  upsertSessionGoal(id: number, goal: goals.UpsertGoalInput): void { goals.upsert(this.db, id, goal); }
  clearSessionGoal(id: number): void { goals.clear(this.db, id); }

  // ─── Messages ──────────────────────────────────────────────────
  appendMessage(sessionId: number, message: AgentMessage, usage?: messages.AppendMessageUsage): number {
    return messages.append(this.db, sessionId, message, usage);
  }
  appendToolCall(input: messages.AppendToolCallInput): void { messages.appendToolCall(this.db, input); }
  bumpSessionUsage(sessionId: number, usage: messages.AppendMessageUsage): void { messages.bumpSessionUsage(this.db, sessionId, usage); }
  persistAssistantTurn(input: messages.PersistAssistantTurnInput): number { return messages.persistAssistantTurn(this.db, input); }
  loadSessionWithMessages(id: number): SessionWithMessages | null { return messages.loadWithMessages(this.db, id); }
  getMessageCount(sessionId: number): number { return messages.getCount(this.db, sessionId); }
  loadSessionMessagesTail(id: number, tail: number): SessionWithMessages | null { return messages.loadTail(this.db, id, tail); }
  getFirstUserMessageText(sessionId: number): string | null { return messages.getFirstUserText(this.db, sessionId); }
  loadMessagesBefore(sessionId: number, beforeId: number, limit: number, includeArchived = false): { messages: AgentMessage[]; message_rows: CoderMessageRow[] } {
    return messages.loadBefore(this.db, sessionId, beforeId, limit, includeArchived);
  }
  listMessagesAfter(sessionId: number, afterId: number): { messages: AgentMessage[]; maxId: number } {
    return messages.listAfter(this.db, sessionId, afterId);
  }
  /** Audit-table results for the given tool_use ids (dashboard status fallback). */
  getToolResultsByToolUseIds(sessionId: number, toolUseIds: string[]): toolResults.ToolCallResultRow[] {
    return toolResults.getToolResultsByToolUseIds(this.db, sessionId, toolUseIds);
  }
  // ─── Durable compaction boundary (migration 128) ───────────────
  getSummaryBoundary(sessionId: number): number { return messages.getBoundary(this.db, sessionId); }
  getArchivedMessageCount(sessionId: number): number { return messages.getArchivedCount(this.db, sessionId); }
  maxMessageId(sessionId: number): number { return messages.maxMessageId(this.db, sessionId); }
  previousUserMessageId(sessionId: number, beforeId: number): number | null {
    return messages.previousUserMessageId(this.db, sessionId, beforeId);
  }
  setCompactionBoundary(sessionId: number, summaryText: string, boundaryId: number, kind: 'auto' | 'manual'): { boundary_id: number; pruned_count: number } {
    return messages.setCompactionBoundary(this.db, sessionId, summaryText, boundaryId, kind);
  }
  getMessageById(sessionId: number, messageId: number): { role: string; content: unknown; row: CoderMessageRow } | null {
    return messages.getById(this.db, sessionId, messageId);
  }

  // ─── Append-only conversation chapters (migration 208) ────────
  commitConversationChapter(input: CommitConversationChapterInput): CommitConversationChapterResult { return chapters.commit(this.db, input); }
  insertRebuiltConversationChapters(sessionId: number, input: readonly RebuiltConversationChapterInput[]): InsertRebuiltConversationChaptersResult { return chapters.insertRebuilt(this.db, sessionId, input); }
  listConversationChapters(sessionId: number, opts: { limit?: number; cursor?: string | null; includeSuperseded?: boolean } = {}): ConversationChapterPage<ConversationChapterRow> { return chapters.list(this.db, sessionId, opts); }
  countConversationChapters(sessionId: number, includeSuperseded = false): number { return chapters.count(this.db, sessionId, includeSuperseded); }
  searchConversationChapters(sessionId: number, query: string, opts: { limit?: number; cursor?: string | null } = {}): ConversationChapterPage<ConversationChapterSearchResult> { return chapters.search(this.db, sessionId, query, opts); }
  getConversationChapter(sessionId: number, chapterId: number): ConversationChapterRow | null { return chapters.get(this.db, sessionId, chapterId); }
  listConversationChapterSource(sessionId: number, chapterId: number, opts: { limit?: number; cursor?: string | null } = {}): ConversationChapterPage<CoderMessageRow> { return chapters.listSource(this.db, sessionId, chapterId, opts); }
  getConversationChapterMessages(sessionId: number, chapterId: number, opts: { limit?: number; cursor?: string | null } = {}): ConversationChapterPage<CoderMessageRow> { return chapters.listSource(this.db, sessionId, chapterId, opts); }
  supersedeConversationChapters(sessionId: number, opts: { source?: ConversationChapterSource; throughEndMessageId?: number } = {}): number { return chapters.supersede(this.db, sessionId, opts); }
  copyConversationChapters(fromSessionId: number, toSessionId: number, idMap?: ReadonlyMap<number, number>): number { return chapters.copy(this.db, fromSessionId, toSessionId, idMap); }
  rollbackConversationChapters(sessionId: number, fromMessageId: number): number { return chapters.rollback(this.db, sessionId, fromMessageId); }
  getConversationChapterStatus(sessionId: number): ConversationChapterStatus { return compactionAttempts.chapterStatus(this.db, sessionId); }
  startCompactionAttempt(input: StartCompactionAttemptInput): number | null { return compactionAttempts.start(this.db, input); }
  finishCompactionAttempt(id: number | null, input: FinishCompactionAttemptInput): void { compactionAttempts.finish(this.db, id, input); }

  // ─── Plans ─────────────────────────────────────────────────────
  recordPlan(input: plans.RecordPlanInput): CoderPlanRow { return plans.record(this.db, input); }
  resolvePlan(toolUseId: string, status: CoderPlanStatus, feedback?: string): void { plans.resolve(this.db, toolUseId, status, feedback); }
  listPlans(sessionId: number): CoderPlanRow[] { return plans.list(this.db, sessionId); }
  getPlan(id: number): CoderPlanRow | null { return plans.get(this.db, id); }

  // ─── Session inputs / hidden-prompt log (migration 061) ────────
  recordSessionInput(input: inputs.RecordSessionInput): SessionInputRow | null { return inputs.record(this.db, input); }
  listSessionInputs(sessionId: number): SessionInputRow[] { return inputs.list(this.db, sessionId); }

  // ─── Session Drive: memory + investigations (migrations 125, 126) ──
  rememberMemory(sessionId: number, input: sessionDrive.RememberInput): sessionDrive.SessionMemoryRow { return sessionDrive.remember(this.db, sessionId, input); }
  listSessionMemory(sessionId: number, opts: { kind?: string } = {}): sessionDrive.SessionMemoryRow[] { return sessionDrive.listMemory(this.db, sessionId, opts); }
  setSessionMemoryPinned(sessionId: number, id: number, pinned: boolean): boolean { return sessionDrive.setMemoryPinned(this.db, sessionId, id, pinned); }
  deleteSessionMemory(sessionId: number, id: number): boolean { return sessionDrive.deleteMemory(this.db, sessionId, id); }
  copySessionMemory(fromSessionId: number, toSessionId: number): number { return sessionDrive.copyMemory(this.db, fromSessionId, toSessionId); }
  recordInvestigation(input: sessionDrive.RecordInvestigationInput): sessionDrive.InvestigationRow { return sessionDrive.recordInvestigation(this.db, input); }
  setInvestigationEmbedding(id: number, embedding: Float32Array): void { sessionDrive.setInvestigationEmbedding(this.db, id, embedding); }
  recallInvestigations(sessionId: number, query: string, limit?: number): sessionDrive.InvestigationRow[] { return sessionDrive.recallInvestigations(this.db, sessionId, query, limit); }
  recallInvestigationsByVector(sessionId: number, queryVec: Float32Array, limit?: number): sessionDrive.InvestigationRow[] { return sessionDrive.recallInvestigationsByVector(this.db, sessionId, queryVec, limit); }
  getDriveAggregate(sessionId: number): sessionDrive.DriveAggregate { return sessionDrive.getDriveAggregate(this.db, sessionId); }
  getDriveInjectionPayload(sessionId: number): sessionDrive.DriveInjectionPayload { return sessionDrive.getDriveInjectionPayload(this.db, sessionId); }
  getSessionStateData(sessionId: number): sessionDrive.SessionStateData { return sessionDrive.getSessionStateData(this.db, sessionId); }
  getCommandTrail(sessionId: number, limit?: number): Array<{ command: string; isError: boolean }> { return sessionDrive.getCommandTrail(this.db, sessionId, limit); }
  didRunSucceed(sessionId: number): boolean { return sessionDrive.didRunSucceed(this.db, sessionId); }

  // ─── Tasks (migration 008) ─────────────────────────────────────
  recordTasks(input: tasks.RecordTasksInput): CoderTasksRow { return tasks.record(this.db, input); }
  resolveTasks(sessionId: number, verdict: { approved: boolean; tasks?: CoderTask[]; execution_mode?: TaskExecutionMode | null }): TasksState | null {
    return tasks.resolve(this.db, sessionId, verdict);
  }
  updateTaskStatus(sessionId: number, taskId: string, patch: Partial<CoderTask>): TasksState | null { return tasks.updateStatus(this.db, sessionId, taskId, patch); }
  getTasksState(sessionId: number): TasksState | null { return tasks.getState(this.db, sessionId); }
  clearTasksState(sessionId: number): boolean { return tasks.clear(this.db, sessionId); }
  recoverStaleTasks(sessionId: number): number { return tasks.recoverStale(this.db, sessionId); }
  getTasksRow(sessionId: number): CoderTasksRow | null { return tasks.getRow(this.db, sessionId); }

  // ─── execute_tasks runs (migration 108) ────────────────────────
  createTaskRun(input: taskRuns.CreateTaskRunInput): void { taskRuns.createRun(this.db, input); }
  updateTaskRun(runId: string, patch: taskRuns.UpdateRunPatch): void { taskRuns.updateRun(this.db, runId, patch); }
  upsertTaskRunItem(input: taskRuns.UpsertItemInput): void { taskRuns.upsertItem(this.db, input); }
  getTaskRun(runId: string): taskRuns.TaskRunRow | null { return taskRuns.getRun(this.db, runId); }
  listTaskRunsBySession(sessionId: number, limit = 25): taskRuns.TaskRunRow[] { return taskRuns.listRunsBySession(this.db, sessionId, limit); }
  listTaskRunItems(runId: string): taskRuns.TaskRunItemRow[] { return taskRuns.listItems(this.db, runId); }
  getTaskRunWithItems(runId: string): { run: taskRuns.TaskRunRow; items: taskRuns.TaskRunItemRow[] } | null { return taskRuns.getRunWithItems(this.db, runId); }
  findLastCompletedTaskItem(taskId: string): taskRuns.TaskRunItemRow | null { return taskRuns.findLastCompletedItem(this.db, taskId); }
  recoverRunningTaskRuns(sessionId?: number): number { return taskRuns.recoverRunningRuns(this.db, sessionId); }

  // ─── Tool stats ────────────────────────────────────────────────
  getToolCallStats(sessionId: number, recentLimit = 30): toolStats.ToolCallStats { return toolStats.getToolCallStats(this.db, sessionId, recentLimit); }

  // ─── Session groups (migration 009) ────────────────────────────
  listGroups(projectId: number): CoderSessionGroup[] { return groups.list(this.db, projectId); }
  createGroup(input: groups.CreateGroupInput): CoderSessionGroup { return groups.create(this.db, input); }
  updateGroup(id: number, patch: { name?: string; color?: string | null; sort_order?: number }): CoderSessionGroup | null { return groups.update(this.db, id, patch); }
  deleteGroup(id: number): void { groups.del(this.db, id); }

  // ─── Disabled tools (per-session) ──────────────────────────────
  getSessionDisabledTools(sessionId: number): Set<string> { return disabledTools.getDisabled(this.db, sessionId); }
  setSessionToolDisabled(sessionId: number, toolName: string, disabled: boolean): void { disabledTools.setDisabled(this.db, sessionId, toolName, disabled); }
  bulkSetSessionToolsDisabled(sessionId: number, toolNames: string[], disabled: boolean): void { disabledTools.bulkSetDisabled(this.db, sessionId, toolNames, disabled); }
  copyToolConfig(fromSessionId: number, toSessionId: number): number { return disabledTools.copyConfig(this.db, fromSessionId, toSessionId); }

  // ─── Per-turn telemetry (migration 069) ────────────────────────
  startSubagentRun(input: subagentTelemetry.StartSubagentRunInput): void { subagentTelemetry.start(this.db, input); }
  recordSubagentToolCall(input: subagentTelemetry.SubagentToolCallInput): void { subagentTelemetry.recordToolCall(this.db, input); }
  completeSubagentRun(input: subagentTelemetry.CompleteSubagentRunInput): void { subagentTelemetry.complete(this.db, input); }
  listSubagentRuns(sessionId: number, limit = 50): subagentTelemetry.SubagentRunTelemetry[] { return subagentTelemetry.listRuns(this.db, sessionId, limit); }
  listSubagentToolCalls(runId: string, limit = 100): subagentTelemetry.SubagentToolCallTelemetry[] { return subagentTelemetry.listToolCalls(this.db, runId, limit); }
  getSubagentBudgetRecommendations(): subagentRecommendations.SubagentBudgetRecommendation[] {
    return subagentRecommendations.getSubagentBudgetRecommendations(this.db);
  }
  recordTurnTelemetry(input: telemetryRecord.RecordTurnTelemetryInput): number | null { return telemetryRecord.record(this.db, input); }
  getFirstTurnPayloadBreakdown(sessionId: number): telemetryPayload.FirstTurnPayloadBreakdown { return telemetryPayload.getFirstTurnPayloadBreakdown(this.db, sessionId); }
  getTurnTelemetry(sessionId: number): Array<Record<string, unknown>> { return telemetryPayload.getTurnTelemetry(this.db, sessionId); }
  getSessionTelemetrySummary(sessionId: number): telemetrySession.SessionTelemetrySummary { return telemetrySession.getSessionTelemetrySummary(this.db, sessionId); }
  getGlobalTelemetrySummary(opts: { limit?: number; project_id?: number | null; since?: string | null } = {}): telemetryGlobal.GlobalTelemetrySummary {
    return telemetryGlobal.getGlobalTelemetrySummary(this.db, opts);
  }
  backfillTurnCosts(opts?: telemetryBackfill.BackfillOptions): telemetryBackfill.BackfillResult {
    return telemetryBackfill.backfillTurnCosts(this.db, opts);
  }
}
