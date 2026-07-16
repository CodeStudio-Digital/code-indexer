/**
 * CompanyStore — CRUD for company templates, sessions, agent runs, board,
 * kanban, archives, pipelines and the agent inbox.
 *
 * Public API. Bodies live in sub-modules under `./company/` so this file
 * stays under the 250-LOC ceiling. Each domain owns its row interface +
 * mapper + functions; we delegate via thin method stubs.
 */
import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';
import type {
  CompanyTemplate, CompanyRoleConfig,
  CompanySession, CompanySessionStatus, CompanySessionProject,
  CompanyAgentRun, AgentRunStatus,
  BoardEntry, BoardKind,
  KanbanCard, KanbanColumn, KanbanTag, KanbanChecklistItem, KanbanComment,
  KanbanCardAgent, KanbanCardDependency, KanbanCardFull,
  MasterPrompt, MasterPromptKind, MasterPromptStatus,
  CompanySessionArchive,
  Pipeline, PipelineExecution, PipelineExecutionStatus, PipelineNodeExecution,
  AgentInboxMessage, InboxStatus,
} from '@mcp/company/types.js';

import * as templatesDomain from './company/templates.js';
import * as sessions from './company/sessions.js';
import * as sessionProjects from './company/session-projects.js';
import * as agentRuns from './company/agent-runs.js';
import * as board from './company/board.js';
import * as masterPrompts from './company/master-prompts.js';
import * as kanbanCards from './company/kanban-cards.js';
import * as kanbanItems from './company/kanban-items.js';
import * as archives from './company/archives.js';
import * as pipelines from './company/pipelines.js';
import * as pipelineExecutions from './company/pipeline-executions.js';
import * as pipelineNodeExecutions from './company/pipeline-node-executions.js';
import * as inbox from './company/inbox.js';
import * as boardWatermarks from './company/board-watermarks.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;

export class CompanyStore {
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
      // used to do unconditionally — created a 3rd writer on the same file
      // and serialized company reads behind WAL lock contention.
      this.db = dbPathOrHandle;
      this.ownsHandle = false;
    }
  }

  close(): void { if (this.ownsHandle) this.db.close(); }

  // ─── Templates ─────────────────────────────────────────────────
  createTemplate(name: string, description: string, roles: CompanyRoleConfig[]): CompanyTemplate { return templatesDomain.createTemplate(this.db, name, description, roles); }
  getTemplate(id: number): CompanyTemplate | null { return templatesDomain.getTemplate(this.db, id); }
  listTemplates(): CompanyTemplate[] { return templatesDomain.listTemplates(this.db); }
  updateTemplate(id: number, patch: { name?: string; description?: string; roles?: CompanyRoleConfig[] }): CompanyTemplate | null { return templatesDomain.updateTemplate(this.db, id, patch); }
  deleteTemplate(id: number): boolean { return templatesDomain.deleteTemplate(this.db, id); }

  // ─── Company Sessions ──────────────────────────────────────────
  createCompanySession(input: sessions.CreateCompanySessionInput): CompanySession { return sessions.create(this.db, input); }
  createChildSession(input: { parent_session_id: number; name: string }): CompanySession { return sessions.createChild(this.db, input.parent_session_id, input.name); }
  listChildSessions(parentSessionId: number): CompanySession[] { return sessions.listChildren(this.db, parentSessionId); }
  getCompanySession(id: number): CompanySession | null { return sessions.get(this.db, id); }
  listCompanySessions(opts?: sessions.ListSessionsOptions): CompanySession[] { return sessions.list(this.db, opts); }
  updateCompanySessionStatus(id: number, status: CompanySessionStatus): void { sessions.updateStatus(this.db, id, status); }
  renameCompanySession(id: number, name: string): void { sessions.rename(this.db, id, name); }
  setMasterSessionId(id: number, masterSessionId: number): void { sessions.setMasterSessionId(this.db, id, masterSessionId); }
  setLastUserMessage(id: number, message: string): void { sessions.setLastUserMessage(this.db, id, message); }
  deleteCompanySession(id: number): boolean { return sessions.del(this.db, id); }
  duplicateCompanySession(sourceId: number, newName: string): CompanySession { return sessions.duplicate(this.db, sourceId, newName); }
  updateCompanySessionConfig(id: number, configJson: string): void { sessions.updateConfig(this.db, id, configJson); }
  clearSessionRecoveryFlag(companySessionId: number): void { sessions.clearRecoveryFlag(this.db, companySessionId); }

  // ─── Session Projects ──────────────────────────────────────────
  addProjectToCompanySession(companySessionId: number, projectId: number, label?: string): void { sessionProjects.add(this.db, companySessionId, projectId, label); }
  removeProjectFromCompanySession(companySessionId: number, projectId: number): void { sessionProjects.remove(this.db, companySessionId, projectId); }
  pruneOrphanCompanySessionProjects(companySessionId: number): number { return sessionProjects.pruneOrphans(this.db, companySessionId); }
  listCompanySessionProjects(companySessionId: number): CompanySessionProject[] { return sessionProjects.list(this.db, companySessionId); }

  // ─── Agent Runs ────────────────────────────────────────────────
  createAgentRun(input: agentRuns.CreateAgentRunInput): CompanyAgentRun { return agentRuns.create(this.db, input); }
  getOrCreateAgentRun(input: agentRuns.CreateAgentRunInput): { run: CompanyAgentRun; created: boolean } { return agentRuns.getOrCreate(this.db, input); }
  getAgentRun(id: number): CompanyAgentRun | null { return agentRuns.get(this.db, id); }
  listAgentRuns(companySessionId: number): CompanyAgentRun[] { return agentRuns.list(this.db, companySessionId); }
  countActiveSubordinatesGlobal(): number { return agentRuns.countActiveSubordinatesGlobal(this.db); }
  listArchivedAgentRuns(archiveId: number): CompanyAgentRun[] { return agentRuns.listArchived(this.db, archiveId); }
  updateAgentRunProvider(id: number, provider: string, model: string, fallbackReason?: string | null): void { agentRuns.updateProvider(this.db, id, provider, model, fallbackReason); }
  updateAgentRunRuntimeSnapshot(id: number, input: Parameters<typeof agentRuns.updateRuntimeSnapshot>[2]): void { agentRuns.updateRuntimeSnapshot(this.db, id, input); }
  updateAgentRunStatus(id: number, status: AgentRunStatus, statusMessage?: string): void { agentRuns.updateStatus(this.db, id, status, statusMessage); }
  deleteAgentRun(id: number): void { agentRuns.remove(this.db, id); }
  recoverStaleAgentRuns(): { agentRuns: number; companySessions: number } { return agentRuns.recoverStale(this.db); }

  // ─── Board ─────────────────────────────────────────────────────
  postToBoard(companySessionId: number, authorRole: string, agentRunId: number | null, kind: BoardKind, content: string, mentions?: string[]): BoardEntry { return board.post(this.db, companySessionId, authorRole, agentRunId, kind, content, mentions); }
  getBoardEntry(id: number): BoardEntry | null { return board.getEntry(this.db, id); }
  readBoard(companySessionId: number, opts?: { sinceId?: number; limit?: number; kind?: BoardKind }): BoardEntry[] { return board.read(this.db, companySessionId, opts); }
  readArchivedBoard(archiveId: number): BoardEntry[] { return board.readArchived(this.db, archiveId); }

  /** Aggregated read: session + projects + agent runs + recent board + recent master prompts. */
  getCompanySessionFull(id: number): {
    session: CompanySession;
    projects: CompanySessionProject[];
    agentRuns: CompanyAgentRun[];
    recentBoard: BoardEntry[];
    masterPrompts: MasterPrompt[];
  } | null {
    const session = sessions.get(this.db, id);
    if (!session) return null;
    return {
      session,
      projects: sessionProjects.list(this.db, id),
      agentRuns: agentRuns.list(this.db, id),
      recentBoard: board.read(this.db, id, { limit: 50 }),
      masterPrompts: masterPrompts.list(this.db, id, { limit: 50 }),
    };
  }

  // ─── Master Prompts ────────────────────────────────────────────
  createMasterPrompt(input: masterPrompts.CreateMasterPromptInput): MasterPrompt { return masterPrompts.create(this.db, input); }
  getMasterPrompt(id: number): MasterPrompt | null { return masterPrompts.get(this.db, id); }
  listMasterPrompts(companySessionId: number, opts?: { limit?: number; status?: MasterPromptStatus }): MasterPrompt[] { return masterPrompts.list(this.db, companySessionId, opts); }
  resolveMasterPrompt(id: number, resolution: masterPrompts.ResolveMasterPromptInput): MasterPrompt | null { return masterPrompts.resolve(this.db, id, resolution); }
  cancelPendingMasterPrompts(companySessionId: number): MasterPrompt[] { return masterPrompts.cancelPending(this.db, companySessionId); }
  getPendingMasterPrompt(companySessionId: number, kind?: MasterPromptKind): MasterPrompt | null { return masterPrompts.getPending(this.db, companySessionId, kind); }

  // ─── Kanban Cards ──────────────────────────────────────────────
  createKanbanCard(sessionId: number, input: kanbanCards.CreateCardInput): KanbanCard { return kanbanCards.create(this.db, sessionId, input); }
  getKanbanCard(cardId: number): KanbanCard | null { return kanbanCards.get(this.db, cardId); }
  getKanbanCardFull(cardId: number): KanbanCardFull | null { return kanbanCards.getFull(this.db, cardId); }
  listKanbanCards(sessionId: number, opts?: { column?: KanbanColumn }): KanbanCard[] { return kanbanCards.list(this.db, sessionId, opts); }
  listArchivedKanbanCards(archiveId: number): KanbanCard[] { return kanbanCards.listArchived(this.db, archiveId); }
  listKanbanCardsFull(sessionId: number): KanbanCardFull[] { return kanbanCards.listFull(this.db, sessionId); }
  moveKanbanCard(cardId: number, toColumn: KanbanColumn, toPosition?: number): KanbanCard { return kanbanCards.move(this.db, cardId, toColumn, toPosition); }
  updateKanbanCard(cardId: number, patch: { title?: string; description?: string; tag?: KanbanTag | null }): KanbanCard | null { return kanbanCards.update(this.db, cardId, patch); }
  deleteKanbanCard(cardId: number): boolean { return kanbanCards.del(this.db, cardId); }

  // ─── Kanban Items (checklist / comments / agents / deps) ───────
  addChecklistItem(cardId: number, text: string, position?: number): KanbanChecklistItem { return kanbanItems.addChecklistItem(this.db, cardId, text, position); }
  updateChecklistItem(itemId: number, patch: { text?: string; checked?: boolean; position?: number }): KanbanChecklistItem | null { return kanbanItems.updateChecklistItem(this.db, itemId, patch); }
  removeChecklistItem(itemId: number): boolean { return kanbanItems.removeChecklistItem(this.db, itemId); }
  getChecklistItem(itemId: number): KanbanChecklistItem | null { return kanbanItems.getChecklistItem(this.db, itemId); }
  addKanbanComment(cardId: number, authorRole: string, agentRunId: number | null, content: string): KanbanComment { return kanbanItems.addComment(this.db, cardId, authorRole, agentRunId, content); }
  listKanbanComments(cardId: number): KanbanComment[] { return kanbanItems.listComments(this.db, cardId); }
  assignAgentToCard(cardId: number, agentRunId: number, role: string): KanbanCardAgent { return kanbanItems.assignAgent(this.db, cardId, agentRunId, role); }
  unassignAgentFromCard(cardId: number, agentRunId: number): void { kanbanItems.unassignAgent(this.db, cardId, agentRunId); }
  findCardByAgentRun(agentRunId: number): KanbanCard | null { return kanbanItems.findCardByAgentRun(this.db, agentRunId); }
  addCardDependency(cardId: number, dependsOnId: number): KanbanCardDependency { return kanbanItems.addDependency(this.db, cardId, dependsOnId); }
  removeCardDependency(cardId: number, dependsOnId: number): boolean { return kanbanItems.removeDependency(this.db, cardId, dependsOnId); }
  getBlockedCards(sessionId: number): KanbanCard[] { return kanbanItems.getBlockedCards(this.db, sessionId); }

  // ─── Session Archives ──────────────────────────────────────────
  archiveCompanySession(companySessionId: number, opts: archives.ArchiveOptions): CompanySessionArchive { return archives.archive(this.db, companySessionId, opts); }
  getArchive(id: number): CompanySessionArchive | null { return archives.getArchive(this.db, id); }
  listArchives(companySessionId: number): CompanySessionArchive[] { return archives.listArchives(this.db, companySessionId); }
  getLatestQaVerdictForCard(companySessionId: number, cardId: number): 'pass' | 'fail' | null { return archives.getLatestQaVerdictForCard(this.db, companySessionId, cardId); }

  // ─── Pipelines ─────────────────────────────────────────────────
  createPipeline(input: pipelines.CreatePipelineInput): Pipeline { return pipelines.create(this.db, input); }
  getPipeline(id: number): Pipeline | null { return pipelines.get(this.db, id); }
  listPipelines(opts?: pipelines.ListPipelinesOptions): Pipeline[] { return pipelines.list(this.db, opts); }
  updatePipeline(id: number, patch: Parameters<typeof pipelines.update>[2], opts?: { expectedVersion?: number }): Pipeline | null { return pipelines.update(this.db, id, patch, opts); }
  deletePipeline(id: number): boolean { return pipelines.del(this.db, id); }
  createPipelineExecution(input: pipelineExecutions.CreateExecutionInput): PipelineExecution { return pipelineExecutions.create(this.db, input); }
  getPipelineExecution(id: number): PipelineExecution | null { return pipelineExecutions.get(this.db, id); }
  listPipelineExecutions(opts: pipelineExecutions.ListExecutionsOptions): PipelineExecution[] { return pipelineExecutions.list(this.db, opts); }
  updatePipelineExecution(id: number, patch: Parameters<typeof pipelineExecutions.update>[2]): PipelineExecution | null { return pipelineExecutions.update(this.db, id, patch); }
  createPipelineNodeExecution(input: pipelineNodeExecutions.CreateNodeExecutionInput): PipelineNodeExecution { return pipelineNodeExecutions.create(this.db, input); }
  getPipelineNodeExecution(id: number): PipelineNodeExecution | null { return pipelineNodeExecutions.get(this.db, id); }
  listPipelineNodeExecutions(executionId: number): PipelineNodeExecution[] { return pipelineNodeExecutions.list(this.db, executionId); }
  updatePipelineNodeExecution(id: number, patch: Parameters<typeof pipelineNodeExecutions.update>[2]): PipelineNodeExecution | null { return pipelineNodeExecutions.update(this.db, id, patch); }

  // ─── Inbox ─────────────────────────────────────────────────────
  createInboxMessage(input: inbox.CreateInboxMessageInput): AgentInboxMessage { return inbox.create(this.db, input); }
  getInboxMessage(id: number): AgentInboxMessage | null { return inbox.get(this.db, id); }
  getInboxMessageByWaitToken(companySessionId: number, token: string): AgentInboxMessage | null { return inbox.getByWaitToken(this.db, companySessionId, token); }
  listInboxMessages(opts: inbox.ListInboxOptions): AgentInboxMessage[] { return inbox.list(this.db, opts); }
  claimNextInboxForAgent(args: { companySessionId: number; agentRunId: number; role: string }): AgentInboxMessage | null { return inbox.claimNextForAgent(this.db, args); }
  answerInboxMessage(id: number, answer: string): AgentInboxMessage | null { return inbox.answer(this.db, id, answer); }
  claimAllPendingMasterMessages(companySessionId: number): AgentInboxMessage[] { return inbox.claimAllPendingMasterMessages(this.db, companySessionId); }
  listSessionsWithPendingMasterInbox(): number[] { return inbox.listSessionsWithPendingMaster(this.db); }
  setInboxStatus(id: number, status: InboxStatus, opts?: { answer?: string }): AgentInboxMessage | null { return inbox.setStatus(this.db, id, status, opts); }

  // ─── Board Watermarks ──────────────────────────────────────────
  setAgentBoardWatermark(companySessionId: number, agentRunId: number, lastSeenBoardId: number): void { boardWatermarks.set(this.db, companySessionId, agentRunId, lastSeenBoardId); }
  getAgentBoardWatermark(companySessionId: number, agentRunId: number): number { return boardWatermarks.get(this.db, companySessionId, agentRunId); }
  listUnreadBoardCounts(companySessionId: number): Array<{ agentRunId: number; role: string; unreadCount: number }> { return boardWatermarks.listUnreadCounts(this.db, companySessionId); }
}
