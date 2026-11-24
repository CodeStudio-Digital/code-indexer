import { ACTIVE_SUBORDINATE_STATUSES } from './company-session-file-values.js';
import { CompanySessionFileBase } from './company-session-file-base.js';
import { CompanyAgentRunFiles } from './company-agent-run-files.js';
import { CompanyBoardFiles } from './company-board-files.js';
import { CompanyKanbanFiles } from './company-kanban-files.js';
import { CompanyKanbanRelations } from './company-kanban-relations.js';
import { CompanyInboxFiles } from './company-inbox-files.js';
import { CompanyMasterPromptFiles } from './company-master-prompt-files.js';

import type { CompanySessionFileSnapshot, CompanyAgentRunFileRow, CreateCompanyAgentRunFileInput, UpdateCompanyAgentRunRuntimeInput, ReadCompanyBoardFileOptions, CreateCompanyInboxFileInput, ListCompanyInboxFileOptions, CreateCompanyMasterPromptFileInput, ResolveCompanyMasterPromptFileInput, CompanyMasterPromptDeliveryClaim } from './company-session-file-types.js';
export type { CompanySessionFileSnapshot, CompanyAgentRunFileRow, CreateCompanyAgentRunFileInput, UpdateCompanyAgentRunRuntimeInput, ReadCompanyBoardFileOptions, CreateCompanyInboxFileInput, ListCompanyInboxFileOptions, CreateCompanyMasterPromptFileInput, ResolveCompanyMasterPromptFileInput, CompanyMasterPromptDeliveryClaim } from './company-session-file-types.js';
import { type CompanySessionId } from '@mcp/session-storage';

import type { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';

/**
 * Filesystem authority for one Company/App Studio bundle.
 *
 * The class intentionally exposes only bundle-local state. Reusable templates,
 * provider catalogs and skill definitions stay in SQLite and are injected by
 * their dedicated stores.
 */
export class CompanySessionFiles extends CompanySessionFileBase {

  /** Family-wide projection; unknown owners remain protected by reconciliation.
   * Read session metadata from disk so cached catalog status is not authority. */
  listCompanyAgentRunsSync(): CompanyAgentRunFileRow[] {
    const companyId = this.getSession().parent_session_id ?? this.companySessionId;
    const runs: CompanyAgentRunFileRow[] = [];
    for (const entry of this.sessionStore.catalog.entriesSnapshot()) {
      if (entry.session.kind !== 'company') continue;
      const files = new CompanySessionFiles({ companySessionId: entry.session.id, sessionStore: this.sessionStore });
      const session = files.getSession();
      if ((session.parent_session_id ?? session.id) === companyId) runs.push(...files.listAgentRunsSync());
    }
    return runs;
  }

  countActiveSubordinatesAcrossCatalog(): number {
    let active = 0;
    for (const entry of this.sessionStore.catalog.list()) {
      if (
        entry.session.kind !== 'company' &&
        entry.session.kind !== 'app_studio'
      ) {
        continue;
      }
      const files = new CompanySessionFiles({
        companySessionId: entry.session.id,
        sessionStore: this.sessionStore,
      });
      active += files
        .listAgentRunsSync()
        .filter(
          (run) =>
            run.role !== 'master' &&
            run.archive_id == null &&
            ACTIVE_SUBORDINATE_STATUSES.has(run.status),
        )
        .length;
    }
    return active;
  }

  private readonly agentRuns = new CompanyAgentRunFiles(this);
  createAgentRun = this.agentRuns.createAgentRun.bind(this.agentRuns);
  getAgentRun = this.agentRuns.getAgentRun.bind(this.agentRuns);
  getAgentRunSync = this.agentRuns.getAgentRunSync.bind(this.agentRuns);
  listAgentRuns = this.agentRuns.listAgentRuns.bind(this.agentRuns);
  listAgentRunsSync = this.agentRuns.listAgentRunsSync.bind(this.agentRuns);
  updateAgentRunStatus = this.agentRuns.updateAgentRunStatus.bind(this.agentRuns);
  updateAgentRunProvider = this.agentRuns.updateAgentRunProvider.bind(this.agentRuns);
  updateAgentRunRuntimeSnapshot = this.agentRuns.updateAgentRunRuntimeSnapshot.bind(this.agentRuns);
  moveAgentRunToTrash = this.agentRuns.moveAgentRunToTrash.bind(this.agentRuns);
  private readonly board = new CompanyBoardFiles(this, this.agentRuns);
  createBoardEntry = this.board.createBoardEntry.bind(this.board);
  getBoardEntrySync = this.board.getBoardEntrySync.bind(this.board);
  listBoardEntriesSync = this.board.listBoardEntriesSync.bind(this.board);
  getAgentBoardWatermarkSync = this.board.getAgentBoardWatermarkSync.bind(this.board);
  setAgentBoardWatermark = this.board.setAgentBoardWatermark.bind(this.board);
  listUnreadBoardCountsSync = this.board.listUnreadBoardCountsSync.bind(this.board);
  private readonly kanban = new CompanyKanbanFiles(this);
  createKanbanCardSync = this.kanban.createKanbanCardSync.bind(this.kanban);
  listKanbanCardsFullSync = this.kanban.listKanbanCardsFullSync.bind(this.kanban);
  listKanbanCardsSync = this.kanban.listKanbanCardsSync.bind(this.kanban);
  getKanbanCardFullSync = this.kanban.getKanbanCardFullSync.bind(this.kanban);
  moveKanbanCardSync = this.kanban.moveKanbanCardSync.bind(this.kanban);
  updateKanbanCardSync = this.kanban.updateKanbanCardSync.bind(this.kanban);
  deleteKanbanCardSync = this.kanban.deleteKanbanCardSync.bind(this.kanban);
  private readonly kanbanRelations = new CompanyKanbanRelations(this, this.kanban);
  addKanbanCommentSync = this.kanbanRelations.addKanbanCommentSync.bind(this.kanbanRelations);
  updateKanbanChecklistSync = this.kanbanRelations.updateKanbanChecklistSync.bind(this.kanbanRelations);
  addKanbanDependencySync = this.kanbanRelations.addKanbanDependencySync.bind(this.kanbanRelations);
  removeKanbanDependencySync = this.kanbanRelations.removeKanbanDependencySync.bind(this.kanbanRelations);
  assignKanbanAgentSync = this.kanbanRelations.assignKanbanAgentSync.bind(this.kanbanRelations);
  unassignKanbanAgentSync = this.kanbanRelations.unassignKanbanAgentSync.bind(this.kanbanRelations);
  private readonly inbox = new CompanyInboxFiles(this, this.agentRuns);
  createInboxMessageSync = this.inbox.createInboxMessageSync.bind(this.inbox);
  getInboxMessageSync = this.inbox.getInboxMessageSync.bind(this.inbox);
  getInboxMessageByWaitTokenSync = this.inbox.getInboxMessageByWaitTokenSync.bind(this.inbox);
  listInboxMessagesSync = this.inbox.listInboxMessagesSync.bind(this.inbox);
  claimNextInboxForAgentSync = this.inbox.claimNextInboxForAgentSync.bind(this.inbox);
  claimAllPendingMasterMessagesSync = this.inbox.claimAllPendingMasterMessagesSync.bind(this.inbox);
  answerInboxMessageSync = this.inbox.answerInboxMessageSync.bind(this.inbox);
  setInboxStatusSync = this.inbox.setInboxStatusSync.bind(this.inbox);
  private readonly masterPrompts = new CompanyMasterPromptFiles(this);
  createMasterPrompt = this.masterPrompts.createMasterPrompt.bind(this.masterPrompts);
  getMasterPrompt = this.masterPrompts.getMasterPrompt.bind(this.masterPrompts);
  getPendingMasterPrompt = this.masterPrompts.getPendingMasterPrompt.bind(this.masterPrompts);
  claimMasterPromptDelivery = this.masterPrompts.claimMasterPromptDelivery.bind(this.masterPrompts);
  releaseMasterPromptDelivery = this.masterPrompts.releaseMasterPromptDelivery.bind(this.masterPrompts);
  markMasterPromptDeliveryOutcomeUnknown = this.masterPrompts.markMasterPromptDeliveryOutcomeUnknown.bind(this.masterPrompts);
  completeMasterPromptDelivery = this.masterPrompts.completeMasterPromptDelivery.bind(this.masterPrompts);
  cancelPendingMasterPrompts = this.masterPrompts.cancelPendingMasterPrompts.bind(this.masterPrompts);

  listSessionsWithPendingMasterInboxAcrossCatalog(
    masterRole = '__master__',
  ): CompanySessionId[] {
    return listCompanySessionsWithPendingMasterInbox(
      this.sessionStore,
      masterRole,
    );
  }
}

/**
 * Scan the in-memory filesystem session catalog for dormant Company/App
 * sessions that still owe work to their master inbox. Callers must initialize
 * the catalog first; no SQLite catalog or session fallback is consulted.
 */
export function listCompanySessionsWithPendingMasterInbox(
  sessionStore: FsSessionStore,
  masterRole = '__master__',
): CompanySessionId[] {
  const sessions: CompanySessionId[] = [];
  for (const entry of sessionStore.catalog.list()) {
    if (
      entry.session.kind !== 'company' &&
      entry.session.kind !== 'app_studio'
    ) {
      continue;
    }
    const files = new CompanySessionFiles({
      companySessionId: entry.session.id,
      sessionStore,
    });
    if (files.getSession().status === 'paused' || files.getSession().archived_at) continue;
    if (
      files.listInboxMessagesSync({
        status: 'pending',
        toRole: masterRole,
        limit: 1,
      }).length > 0
    ) {
      sessions.push(files.companySessionId);
    }
  }
  return sessions;
}
