import type { AgentMessage } from '@mcp/provider-sdk';
import {
  SessionLocator,
  type FileSessionRepository,
  type ProjectId,
  type ProjectRootResolver,
  type RestoreResult,
  type SessionCatalog,
  type SessionId,
  type SessionLocation,
  type TrashedSessionEntry,
  type TrashResult,
} from '@mcp/session-storage';
import { FsConversationReader } from './conversation-reader.js';
import { FsConversationWriter } from './conversation-writer.js';
import { installExternalImportApi, type FsExternalImportApi } from './external-import-repository.js';
import { FsSessionDirectory, type FsSessionDirectoryOptions } from './session-directory.js';
import { FsSessionMutations } from './session-mutations.js';
import { queryMcpRunMetadata, type FsMcpRunQuery } from './mcp-run-query.js';
import { FsToolOutputReader } from './tool-output-reader.js';
import { FsSessionEntityFiles } from './entity-files.js';
import { recordStandaloneSubagentUsage } from './standalone-usage-metric.js';
import { installSessionOperationsApi, type FsSessionOperationsApi } from './session-operations-api.js';
import { installSessionRollbackApi, type FsSessionRollbackApi } from './session-rollback-api.js';
import {
  installHistoryMetricsApi,
  type FsHistoryMetricsApi,
} from './history-metrics-api.js';
import {
  installSnapshotReviewApi,
  type FsSnapshotReviewApi,
} from './snapshot-review-api.js';
import {
  FsOperationalSessionStore,
  installOperationalSessionApi,
  type FsOperationalSessionApi,
} from './operational-store.js';
import {
  installOrchestrationSubagentApi,
  type FsOrchestrationSubagentApi,
} from './orchestration-subagent-api.js';
import type {
  FsAppendMessageInput,
  FsAppendToolCallInput,
  FsCoderMessageRow,
  FsCoderSession,
  FsCoderSessionStatus,
  FsCreateGlobalSessionInput,
  FsCreateSessionInput,
  FsGlobalCoderSession,
  FsLinkedProject,
  FsLinkProjectInput,
  FsMessagePage,
  FsMetricsSummary,
  FsPersistAssistantTurnInput,
  FsProjectInfo,
  FsSessionWithMessages,
  FsToolCallResult,
  FsToolOutputRead,
} from './types.js';

export type FsSessionStoreOptions = FsSessionDirectoryOptions;
export interface FsSessionStoreFromRootsOptions {
  dataDir: string;
  projectRootResolver: ProjectRootResolver;
  writerOwnerId?: string;
  projectInfoResolver?: (
    projectId: ProjectId,
  ) => FsProjectInfo | null | undefined;
}
/**
 * Filesystem-backed coder runtime facade. It has no database handle, no
 * compatibility reads and no dual-write path.
 */
export class FsSessionStore {
  readonly #directory: FsSessionDirectory;
  readonly #mutations: FsSessionMutations;
  readonly #writer: FsConversationWriter;
  readonly #reader: FsConversationReader;
  readonly #toolOutputs: FsToolOutputReader;
  constructor(options: FsSessionStoreOptions) {
    this.#directory = new FsSessionDirectory(options);
    this.#mutations = new FsSessionMutations(this.#directory);
    this.#writer = new FsConversationWriter(this.#directory);
    this.#reader = new FsConversationReader(this.#directory);
    this.#toolOutputs = new FsToolOutputReader(this.#directory);
    const entities = new FsSessionEntityFiles(this.#directory);
    installOrchestrationSubagentApi(this, this.#directory, entities);
    installOperationalSessionApi(this, new FsOperationalSessionStore(this.#directory));
    installHistoryMetricsApi(this, this.#directory, this.#reader);
    installSnapshotReviewApi(this, this.#directory);
    installSessionOperationsApi(this, this.#directory);
    installSessionRollbackApi(this, this.#directory);
    installExternalImportApi(this, this.#directory);
  }
  static fromRoots(options: FsSessionStoreFromRootsOptions): FsSessionStore {
    const locator = new SessionLocator({
      dataDir: options.dataDir,
      projectRootResolver: options.projectRootResolver,
    });
    return new FsSessionStore({
      locator,
      ...(options.writerOwnerId ? { writerOwnerId: options.writerOwnerId } : {}),
      ...(options.projectInfoResolver ? { projectInfoResolver: options.projectInfoResolver } : {}),
    });
  }
  get locator(): SessionLocator { return this.#directory.locator; }
  get repository(): FileSessionRepository { return this.#directory.repository; }
  get catalog(): SessionCatalog { return this.#directory.catalog; }
  refresh(): Promise<void> { return this.#directory.refresh(); }

  /** Lazily prime the in-memory catalog without forcing a rescan per caller. */
  ensureCatalog(): Promise<void> { return this.#directory.ensureCatalog(); }

  async getSessionLocation(
    id: SessionId | string,
  ): Promise<SessionLocation | null> {
    return (await this.#directory.entry(id))?.location ?? null;
  }

  runSessionMutation<T>(
    id: SessionId | string,
    task: () => Promise<T>,
  ): Promise<T> {
    return this.#directory.runMutation(id, () => this.#directory.requireEntry(id).then(task));
  }

  createSession(input: FsCreateSessionInput): Promise<FsCoderSession> {
    return this.#directory.createSession(input);
  }

  createGlobalSession(
    input: FsCreateGlobalSessionInput,
  ): Promise<FsCoderSession> {
    return this.#directory.createGlobalSession(input);
  }

  getSession(id: SessionId | string): Promise<FsCoderSession | null> {
    return this.#directory.getSession(id);
  }

  refreshSession(id: SessionId | string): Promise<FsCoderSession | null> {
    return this.#directory.refreshSession(id);
  }

  getLastUsedProviderModel(): Promise<{
    provider: string;
    model: string;
  } | null> {
    return this.#directory.getLastUsedProviderModel();
  }

  listSessions(
    projectId: ProjectId,
    options: {
      archived?: boolean | null;
      groupId?: string | null;
    } = {},
  ): Promise<FsCoderSession[]> {
    return this.#directory.listSessions(projectId, options);
  }

  async listMcpRunMetadata(query: FsMcpRunQuery) {
    await this.#directory.ensureCatalog();
    return queryMcpRunMetadata(this.#directory.catalog.entriesSnapshot(), query);
  }

  listGlobalSessions(
    options: { archived?: boolean | null } = {},
  ): Promise<FsGlobalCoderSession[]> {
    return this.#directory.listGlobalSessions(options);
  }

  getSessionProjects(id: SessionId | string): Promise<FsLinkedProject[]> {
    return this.#directory.getSessionProjects(id);
  }
  linkSessionProject(id: SessionId | string, input: FsLinkProjectInput): Promise<FsLinkedProject[]> { return this.#mutations.linkProject(id, input); }
  unlinkSessionProject(id: SessionId | string, projectId: ProjectId): Promise<FsLinkedProject[]> { return this.#mutations.unlinkProject(id, projectId); }
  countSessionsForProject(projectId: ProjectId): Promise<number> {
    return this.#directory.countSessionsForProject(projectId);
  }

  setSessionAgent(id: SessionId | string, agent: string | null): Promise<void> {
    return this.#mutations.setAgent(id, agent);
  }

  setSessionTitle(id: SessionId | string, title: string): Promise<void> {
    return this.#mutations.setTitle(id, title);
  }

  setSessionFavorite(id: SessionId | string, favorite: boolean): Promise<void> {
    return this.#mutations.setFavorite(id, favorite);
  }

  setSessionArchived(id: SessionId | string, archived: boolean): Promise<void> {
    return this.#mutations.setArchived(id, archived);
  }

  updateSessionStatus(
    id: SessionId | string,
    status: FsCoderSessionStatus,
  ): Promise<void> {
    return this.#mutations.updateStatus(id, status);
  }

  updateSessionProvider(
    id: SessionId | string,
    provider: string,
    model: string,
  ): Promise<void> {
    return this.#mutations.updateProvider(id, provider, model);
  }

  touchSession(id: SessionId | string): Promise<void> {
    return this.#mutations.touch(id);
  }

  setSessionTodos(
    id: SessionId | string,
    todosJson: string | null,
  ): Promise<void> {
    return this.#mutations.setTodos(id, todosJson);
  }

  appendMessage(input: FsAppendMessageInput): Promise<number> {
    return this.#writer.appendMessage(input);
  }

  appendToolCall(input: FsAppendToolCallInput): Promise<void> {
    return this.#writer.appendToolCall(input);
  }

  persistAssistantTurn(
    input: FsPersistAssistantTurnInput,
  ): Promise<number> {
    return this.#writer.persistAssistantTurn(input);
  }

  loadSessionWithMessages(id: SessionId | string): Promise<FsSessionWithMessages | null> {
    return this.#reader.loadSession(id);
  }
  loadAllSessionMessages(id: SessionId | string): Promise<FsSessionWithMessages | null> { return this.#reader.loadAll(id); }

  getMessageCount(id: SessionId | string): Promise<number> {
    return this.#reader.count(id);
  }

  listSessionAttachments(id: SessionId | string, offset = 0, limit = 50) {
    return this.#reader.listAttachments(id, offset, limit);
  }

  readSessionAttachment(id: SessionId | string, seq: number, index: number) {
    return this.#reader.readAttachment(id, seq, index);
  }

  loadSessionMessagesTail(
    id: SessionId | string,
    tail: number,
  ): Promise<FsSessionWithMessages | null> {
    return this.#reader.loadTail(id, tail);
  }

  loadMessagesBefore(
    id: SessionId | string,
    beforeSeq: number,
    limit: number,
    includeArchived = false,
  ): Promise<FsMessagePage> {
    return this.#reader.loadBefore(
      id,
      beforeSeq,
      limit,
      includeArchived,
    );
  }

  listMessagesAfter(
    id: SessionId | string,
    afterSeq: number,
  ): Promise<{ messages: AgentMessage[]; maxSeq: number }> {
    return this.#reader.listAfter(id, afterSeq);
  }

  getMessageBySeq(
    id: SessionId | string,
    seq: number,
  ): Promise<{
    role: AgentMessage['role'];
    content: unknown;
    row: FsCoderMessageRow;
  } | null> {
    return this.#reader.getMessage(id, seq);
  }

  getFirstUserMessageText(id: SessionId | string): Promise<string | null> {
    return this.#reader.firstUserText(id);
  }

  getLatestNonMetaUserMessageText(
    id: SessionId | string,
  ): Promise<string | null> {
    return this.#reader.latestUserText(id);
  }

  maxMessageSeq(id: SessionId | string): Promise<number> {
    return this.#reader.maxSeq(id);
  }

  previousUserMessageSeq(
    id: SessionId | string,
    beforeSeq: number,
  ): Promise<number | null> {
    return this.#reader.previousUserSeq(id, beforeSeq);
  }

  getSummaryBoundary(id: SessionId | string): Promise<number> {
    return this.#reader.summaryBoundary(id);
  }

  getArchivedMessageCount(id: SessionId | string): Promise<number> {
    return this.#reader.archivedCount(id);
  }

  setCompactionBoundary(
    id: SessionId | string,
    summaryText: string,
    boundarySeq: number,
    kind: 'auto' | 'manual',
  ): Promise<{ boundary_seq: number; pruned_count: number }> {
    return this.#reader.setCompactionBoundary(
      id,
      summaryText,
      boundarySeq,
      kind,
    );
  }

  getToolOutput(
    id: SessionId | string,
    callId: string,
  ): Promise<FsToolOutputRead | null> {
    return this.#toolOutputs.get(id, callId);
  }

  getToolResultsByToolUseIds(
    id: SessionId | string,
    toolUseIds: readonly string[],
  ): Promise<FsToolCallResult[]> {
    return this.#toolOutputs.getResults(id, toolUseIds);
  }

  getMetricsSummary(
    id: SessionId | string,
  ): Promise<FsMetricsSummary> {
    return this.#directory.getMetricsSummary(id);
  }

  async bumpSessionUsage(
    id: SessionId | string,
    usage: import('./types.js').FsAppendMessageUsage,
    operationKey?: string,
  ): Promise<void> {
    await recordStandaloneSubagentUsage(
      this.#directory,
      id,
      usage,
      operationKey,
    );
  }

  rebuildMetricsSummary(
    id: SessionId | string,
  ): Promise<FsMetricsSummary> {
    return this.#directory.rebuildMetricsSummary(id);
  }

  recoverStaleSessions(): Promise<number> {
    return this.#mutations.recoverStale();
  }

  recoverStuckRunningSessions(
    options: { maxAgeMs?: number } = {},
  ): Promise<number> {
    return this.#mutations.recoverStuck(options);
  }

  deleteSession(id: SessionId | string): Promise<TrashResult> {
    return this.#mutations.delete(id);
  }

  deleteSessionsBatch(
    ids: readonly (SessionId | string)[],
  ): Promise<number> {
    return this.#mutations.deleteBatch(ids);
  }

  trashSessionsBatch(
    ids: readonly (SessionId | string)[],
  ): Promise<readonly TrashResult[]> {
    return this.#mutations.deleteBatchDetailed(ids);
  }

  restoreTrashedSession(
    scope: SessionLocation['scope'],
    trashName: string,
  ): Promise<RestoreResult> {
    return this.#mutations.restore(scope, trashName);
  }

  listTrashedSessions(
    scope: SessionLocation['scope'],
  ): Promise<readonly TrashedSessionEntry[]> {
    return this.#mutations.listTrash(scope);
  }

  getTrashedSession(
    scope: SessionLocation['scope'],
    trashName: string,
  ): Promise<TrashedSessionEntry> {
    return this.#mutations.getTrash(scope, trashName);
  }

  purgeTrashedSession(
    scope: SessionLocation['scope'],
    trashName: string,
  ): Promise<void> {
    return this.#mutations.purge(scope, trashName);
  }

  close(): Promise<void> {
    return this.#directory.close();
  }
}
export interface FsSessionStore extends FsOperationalSessionApi, FsHistoryMetricsApi,
  FsSnapshotReviewApi, FsSessionOperationsApi, FsSessionRollbackApi, FsExternalImportApi,
  FsOrchestrationSubagentApi {}
