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
  SessionInputRow,
  SessionWithMessages,
  TaskExecutionMode,
  TasksState,
} from '@mcp/code-agent/sessions/types.js';

import * as core from './store/sessions-core.js';
import * as state from './store/sessions-state.js';
import * as ops from './store/sessions-ops.js';
import * as goals from './store/goals.js';
import * as messages from './store/messages.js';
import * as plans from './store/plans.js';
import * as inputs from './store/inputs.js';
import * as tasks from './store/tasks.js';
import * as toolStats from './store/tool-stats.js';
import * as groups from './store/groups.js';
import * as disabledTools from './store/disabled-tools.js';
import * as telemetryRecord from './store/telemetry-record.js';
import * as telemetryPayload from './store/telemetry-payload.js';
import * as telemetrySession from './store/telemetry-session.js';
import * as telemetryGlobal from './store/telemetry-global.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;

export class SessionStore {
  private db: DB;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  close(): void { this.db.close(); }
  /** Escape hatch for sibling stores on the same SQLite file. */
  getDb(): DB { return this.db; }

  // ─── Sessions CRUD ─────────────────────────────────────────────
  createSession(input: core.CreateSessionInput): CoderSession { return core.create(this.db, input); }
  getSession(id: number): CoderSession | null { return core.get(this.db, id); }
  listSessions(projectId: number, opts: { archived?: boolean | null; groupId?: number | null } = {}): CoderSession[] { return core.list(this.db, projectId, opts); }
  listRecentSessionsGlobal(limit = 10): RecentCoderSession[] { return core.listRecentGlobal(this.db, limit); }
  deleteSession(id: number): void { core.del(this.db, id); }
  deleteSessionsBatch(ids: number[]): number { return core.delBatch(this.db, ids); }
  recoverStaleSessions(): number { return core.recoverStale(this.db); }

  // ─── Sessions state (set*) ─────────────────────────────────────
  setSessionAgent(id: number, agent: string | null): void { state.setAgent(this.db, id, agent); }
  setSessionTemperature(id: number, temperature: number | null): void { state.setTemperature(this.db, id, temperature); }
  setSessionUnrestrictedToolOutput(id: number, enabled: boolean | null): void { state.setUnrestrictedToolOutput(this.db, id, enabled); }
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

  // ─── Sessions ops (stats, fork, duplicate) ─────────────────────
  getSessionStats(id: number): CoderSessionStats | null { return ops.getStats(this.db, id); }
  forkSessionBeforeMessage(sourceSessionId: number, beforeMessageId: number): { session: CoderSession; seed_text: string } {
    return ops.forkBeforeMessage(this.db, sourceSessionId, beforeMessageId);
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
  persistAssistantTurn(input: messages.PersistAssistantTurnInput): number { return messages.persistAssistantTurn(this.db, input); }
  loadSessionWithMessages(id: number): SessionWithMessages | null { return messages.loadWithMessages(this.db, id); }
  getMessageCount(sessionId: number): number { return messages.getCount(this.db, sessionId); }
  loadSessionMessagesTail(id: number, tail: number): SessionWithMessages | null { return messages.loadTail(this.db, id, tail); }
  loadMessagesBefore(sessionId: number, beforeId: number, limit: number): { messages: AgentMessage[]; message_rows: CoderMessageRow[] } {
    return messages.loadBefore(this.db, sessionId, beforeId, limit);
  }
  getMessageById(sessionId: number, messageId: number): { role: string; content: unknown; row: CoderMessageRow } | null {
    return messages.getById(this.db, sessionId, messageId);
  }

  // ─── Plans ─────────────────────────────────────────────────────
  recordPlan(input: plans.RecordPlanInput): CoderPlanRow { return plans.record(this.db, input); }
  resolvePlan(toolUseId: string, status: CoderPlanStatus, feedback?: string): void { plans.resolve(this.db, toolUseId, status, feedback); }
  listPlans(sessionId: number): CoderPlanRow[] { return plans.list(this.db, sessionId); }
  getPlan(id: number): CoderPlanRow | null { return plans.get(this.db, id); }
  listTodoHistory(sessionId: number): { id: number; args_json: string; created_at: string }[] { return plans.listTodoHistory(this.db, sessionId); }

  // ─── Session inputs / hidden-prompt log (migration 061) ────────
  recordSessionInput(input: inputs.RecordSessionInput): SessionInputRow | null { return inputs.record(this.db, input); }
  listSessionInputs(sessionId: number): SessionInputRow[] { return inputs.list(this.db, sessionId); }

  // ─── Tasks (migration 008) ─────────────────────────────────────
  recordTasks(input: tasks.RecordTasksInput): CoderTasksRow { return tasks.record(this.db, input); }
  resolveTasks(sessionId: number, verdict: { approved: boolean; tasks?: CoderTask[]; execution_mode?: TaskExecutionMode | null }): TasksState | null {
    return tasks.resolve(this.db, sessionId, verdict);
  }
  updateTaskStatus(sessionId: number, taskId: string, patch: Partial<CoderTask>): TasksState | null { return tasks.updateStatus(this.db, sessionId, taskId, patch); }
  getTasksState(sessionId: number): TasksState | null { return tasks.getState(this.db, sessionId); }
  recoverStaleTasks(sessionId: number): number { return tasks.recoverStale(this.db, sessionId); }
  getTasksRow(sessionId: number): CoderTasksRow | null { return tasks.getRow(this.db, sessionId); }

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
  recordTurnTelemetry(input: telemetryRecord.RecordTurnTelemetryInput): number | null { return telemetryRecord.record(this.db, input); }
  getFirstTurnPayloadBreakdown(sessionId: number): telemetryPayload.FirstTurnPayloadBreakdown { return telemetryPayload.getFirstTurnPayloadBreakdown(this.db, sessionId); }
  getTurnTelemetry(sessionId: number): Array<Record<string, unknown>> { return telemetryPayload.getTurnTelemetry(this.db, sessionId); }
  getSessionTelemetrySummary(sessionId: number): telemetrySession.SessionTelemetrySummary { return telemetrySession.getSessionTelemetrySummary(this.db, sessionId); }
  getGlobalTelemetrySummary(opts: { limit?: number; project_id?: number | null; since?: string | null } = {}): telemetryGlobal.GlobalTelemetrySummary {
    return telemetryGlobal.getGlobalTelemetrySummary(this.db, opts);
  }
}
