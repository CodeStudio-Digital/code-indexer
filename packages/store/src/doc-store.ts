/**
 * DocStore — CRUD over the documentation-corpus tables introduced by
 * migration 086 (`doc_collections`, `doc_sources`, `doc_chunks`) + the FTS5
 * helpers needed by `DocHybridSearch`. Vector identity and lifecycle are
 * recorded exclusively in `semantic_items`; migration 233 removes the
 * historical `doc_chunk_vectors` mirror.
 *
 * Tables are GLOBAL (no `project_id`) — collections are shared across all
 * projects. LLM model selection for ingestion/search lives in
 * `pipeline_provider_bindings` (migration 085), not on the collection row.
 *
 * Public API. Bodies live in sub-modules under `./doc/` so this file stays
 * under the 250-LOC ceiling.
 */
import type DatabaseConstructor from 'better-sqlite3';
import * as collections from './doc/collections.js';
import * as sources from './doc/sources.js';
import * as chunks from './doc/chunks.js';
import * as vectorMapping from './doc/vector-mapping.js';
import * as fts from './doc/fts.js';
import * as suggestions from './doc/suggestions.js';
import * as projectLinks from './doc/project-links.js';
import * as ingestRuns from './doc/ingest-runs.js';
import * as ragTelemetry from './doc/rag-telemetry.js';

type DB = InstanceType<typeof DatabaseConstructor>;

// Documentation type taxonomy (migration 149) — vocabulary + helpers.
export {
  DOC_TYPES,
  DEFAULT_DOC_TYPE,
  DOC_TYPE_LABELS,
  coerceDocType,
  type DocType,
} from './doc/doc-type.js';

// Re-export public types so consumers of `@mcp/store/doc-store.js`
// keep working unchanged.
export type {
  DocCollectionStatus,
  DocSourceType,
  DocSourceStatus,
  DocCollection,
  DocCollectionInput,
  DocCrawlConfig,
  DocSource,
  DocFolderConfig,
  DocSourceInput,
  DocChunkInput,
  DocChunk,
  DocFtsHit,
  DocSourceHealth,
  DocVectorRef,
  DocSuggestionStatus,
  DocSourceSuggestion,
  DocProjectLinkOrigin,
  DocProjectLink,
  DocEnrichmentMode,
  DocIngestPerformanceProfile,
  DocIngestRun,
  DocIngestRunState,
  DocSourceItem,
} from './doc/types.js';

import type {
  DocChunk,
  DocChunkInput,
  DocCollection,
  DocCollectionInput,
  DocCollectionStatus,
  DocCrawlConfig,
  DocFolderConfig,
  DocFtsHit,
  DocProjectLink,
  DocProjectLinkOrigin,
  DocSource,
  DocSourceHealth,
  DocSourceInput,
  DocSourceStatus,
  DocSourceSuggestion,
  DocSuggestionStatus,
  DocVectorRef,
  DocEnrichmentMode,
  DocIngestPerformanceProfile,
  DocIngestRun,
  DocSourceItem,
} from './doc/types.js';

export class DocStore {
  constructor(private db: DB) {}

  /** Scope a synchronous write to a connection-local busy ceiling. Worker
   * telemetry uses zero so a contested best-effort event never stalls the
   * agent stream; its buffer retries later through a timer. */
  withBusyTimeout<T>(busyTimeoutMs: number, operation: () => T): T {
    const timeout = Math.max(0, Math.trunc(busyTimeoutMs));
    const previous = Number(this.db.pragma('busy_timeout', { simple: true }));
    if (previous === timeout) return operation();
    this.db.pragma(`busy_timeout = ${timeout}`);
    try {
      return operation();
    } finally {
      this.db.pragma(`busy_timeout = ${previous}`);
    }
  }

  // ─── Collections ──────────────────────────────────────────────
  createCollection(input: DocCollectionInput): DocCollection { return collections.create(this.db, input); }
  getCollection(id: number): DocCollection | null { return collections.get(this.db, id); }
  getCollectionByName(name: string): DocCollection | null { return collections.getByName(this.db, name); }
  listCollections(): DocCollection[] { return collections.list(this.db); }
  updateCollectionStatus(id: number, status: DocCollectionStatus, message?: string | null): void { collections.updateStatus(this.db, id, status, message); }
  refreshCollectionCounts(id: number): void { collections.refreshCounts(this.db, id); }
  deleteCollection(id: number): void { collections.del(this.db, id); }

  // ─── Sources ──────────────────────────────────────────────────
  createSource(input: DocSourceInput): DocSource { return sources.create(this.db, input); }
  getSource(id: number): DocSource | null { return sources.get(this.db, id); }
  listSourcesByCollection(collectionId: number): DocSource[] { return sources.listByCollection(this.db, collectionId); }
  updateSourceStatus(id: number, status: DocSourceStatus, errorMessage?: string | null): void { sources.updateStatus(this.db, id, status, errorMessage); }
  updateSourceStats(id: number, patch: sources.SourceStatsPatch): void { sources.updateStats(this.db, id, patch); }
  deleteSource(id: number): void { sources.del(this.db, id); }
  updateSourceCrawlConfig(id: number, crawl: DocCrawlConfig): void { sources.updateCrawlConfig(this.db, id, crawl); }
  updateSourceDocType(id: number, docType: string): void { sources.updateDocType(this.db, id, docType); }
  updateSourceFolderConfig(id: number, folder: DocFolderConfig): void { sources.updateFolderConfig(this.db, id, folder); }
  updateSourceEnrichmentMode(id: number, mode: DocEnrichmentMode): void { sources.updateEnrichmentMode(this.db, id, mode); }
  getSourceHealth(sourceId: number): DocSourceHealth | null { return sources.getHealth(this.db, sourceId); }
  tryAcquireSource(id: number, staleAfterMs: number = 5 * 60 * 1000): boolean { return sources.tryAcquire(this.db, id, staleAfterMs); }
  recoverStaleSources(): { recovered: number } { return sources.recoverStale(this.db); }

  // ─── Chunks ───────────────────────────────────────────────────
  insertChunks(inputs: DocChunkInput[]): number[] { return chunks.insert(this.db, inputs); }
  replaceChunksForSource(sourceId: number, inputs: DocChunkInput[]): number[] { return chunks.replaceForSource(this.db, sourceId, inputs); }
  getChunk(id: number): DocChunk | null { return chunks.get(this.db, id); }
  getChunksByIds(ids: readonly number[]): DocChunk[] { return chunks.getByIds(this.db, ids); }
  getChunkNeighbors(chunkId: number, window: number = 1): DocChunk[] { return chunks.getNeighbors(this.db, chunkId, window); }
  listChunksBySource(sourceId: number): DocChunk[] { return chunks.listBySource(this.db, sourceId); }
  listChunksByCollection(collectionId: number): DocChunk[] { return chunks.listByCollection(this.db, collectionId); }
  listChunksBySourceHeading(sourceId: number, headingPath: string | null, sourceUri: string | null): DocChunk[] { return chunks.listBySourceHeading(this.db, sourceId, headingPath, sourceUri); }
  clearEmbeddingsForSource(sourceId: number): { cleared: number } { return chunks.clearEmbeddingsForSource(this.db, sourceId); }
  clearEmbeddingsForCollection(collectionId: number): { cleared: number } { return chunks.clearEmbeddingsForCollection(this.db, collectionId); }
  clearAllEmbeddings(): { cleared: number } { return chunks.clearAllEmbeddings(this.db); }
  listChunksMissingEmbedding(opts: { sourceId?: number; collectionId?: number; limit?: number; fingerprint?: string } = {}): DocChunk[] { return chunks.listMissingEmbedding(this.db, opts); }
  updateChunkEmbedding(chunkId: number, embeddingHash: string, providerId: string): void { chunks.updateEmbedding(this.db, chunkId, embeddingHash, providerId); }
  updateChunkEmbeddingState(chunkId: number, embeddingHash: string, fingerprint: string): void { chunks.updateEmbeddingState(this.db, chunkId, embeddingHash, fingerprint); }
  listChunksPendingEnrichment(sourceId: number, limit?: number): DocChunk[] { return chunks.listPendingEnrichment(this.db, sourceId, limit); }
  updateChunkEnrichment(chunkId: number, summary: string | null, concepts: readonly string[], fingerprint: string): void {
    chunks.updateEnrichment(this.db, chunkId, summary, concepts, fingerprint);
  }
  countChunksByCollection(collectionId: number): number { return chunks.countByCollection(this.db, collectionId); }
  countChunksBySource(sourceId: number): number { return chunks.countBySource(this.db, sourceId); }
  countChunksMissingEmbeddingBySource(sourceId: number): number { return chunks.countMissingEmbeddingBySource(this.db, sourceId); }
  countChunksMissingEmbedding(opts: { sourceId?: number; collectionId?: number; fingerprint?: string } = {}): number { return chunks.countMissingEmbedding(this.db, opts); }
  upsertChunksForItem(sourceId: number, itemKey: string, runId: number, inputs: DocChunkInput[]): chunks.UpsertItemChunksResult {
    return chunks.upsertForItem(this.db, sourceId, itemKey, runId, inputs);
  }
  upsertChunksForItems(sourceId: number, runId: number, items: ReadonlyArray<{ itemKey: string; inputs: DocChunkInput[] }>): chunks.UpsertItemChunksResult[] {
    return chunks.upsertForItems(this.db, sourceId, runId, items);
  }
  removeChunksForItems(sourceId: number, itemKeys: readonly string[]): DocVectorRef[] { return chunks.removeForItems(this.db, sourceId, itemKeys); }
  removeLegacyChunks(sourceId: number): DocVectorRef[] { return chunks.removeLegacy(this.db, sourceId); }

  // ─── Vector mapping ───────────────────────────────────────────
  listVectorIdsForSource(sourceId: number): DocVectorRef[] { return vectorMapping.listForSource(this.db, sourceId); }
  listVectorIdsForCollection(collectionId: number): DocVectorRef[] { return vectorMapping.listForCollection(this.db, collectionId); }
  countVectorMappings(): number { return vectorMapping.countMappings(this.db); }
  countIndexedVectorsByCollection(collectionId: number): number { return vectorMapping.countIndexedForCollection(this.db, collectionId); }
  deleteSemanticItemsByVectorIds(namespace: string, vectorIds: readonly string[]): number {
    return vectorMapping.deleteSemanticItemsByVectorIds(this.db, namespace, vectorIds);
  }
  deleteSemanticItemsByItemKeys(namespace: string, itemKeys: readonly string[]): number {
    return vectorMapping.deleteSemanticItemsByItemKeys(this.db, namespace, itemKeys);
  }

  // ─── Incremental ingest runs + source manifest ───────────────
  createIngestRun(sourceId: number, options: unknown, performanceProfile?: string, workerCount?: number): DocIngestRun {
    return ingestRuns.createRun(this.db, sourceId, options, performanceProfile, workerCount);
  }
  resumeIngestRun(runId: number): DocIngestRun | null { return ingestRuns.resumeRun(this.db, runId); }
  getIngestRun(id: number): DocIngestRun | null { return ingestRuns.getRun(this.db, id); }
  getActiveIngestRun(sourceId: number): DocIngestRun | null { return ingestRuns.getActiveRun(this.db, sourceId); }
  listIngestRuns(sourceId: number, limit?: number): DocIngestRun[] { return ingestRuns.listRuns(this.db, sourceId, limit); }
  updateIngestRun(id: number, patch: ingestRuns.RunCountersPatch): void { ingestRuns.updateRun(this.db, id, patch); }
  requestIngestCancel(sourceId: number): boolean { return ingestRuns.requestCancel(this.db, sourceId); }
  requestIngestPause(sourceId: number): boolean { return ingestRuns.requestPause(this.db, sourceId); }
  isIngestCancelRequested(runId: number): boolean { return ingestRuns.isCancelRequested(this.db, runId); }
  isIngestPauseRequested(runId: number): boolean { return ingestRuns.isPauseRequested(this.db, runId); }
  updateIngestPerformance(sourceId: number, profile: string, workerCount: number): boolean {
    return ingestRuns.updatePerformance(this.db, sourceId, profile, workerCount);
  }
  getSourceItem(sourceId: number, itemKey: string): DocSourceItem | null { return ingestRuns.getItem(this.db, sourceId, itemKey); }
  upsertSourceItem(input: Parameters<typeof ingestRuns.upsertItem>[1]): DocSourceItem { return ingestRuns.upsertItem(this.db, input); }
  upsertSourceItems(inputs: ReadonlyArray<Parameters<typeof ingestRuns.upsertItem>[1]>): void { ingestRuns.upsertItems(this.db, inputs); }
  listSourceItemsNotSeen(sourceId: number, runId: number): DocSourceItem[] { return ingestRuns.listItemsNotSeen(this.db, sourceId, runId); }
  deleteSourceItems(ids: readonly number[]): void { ingestRuns.deleteItems(this.db, ids); }
  getDocEnrichmentCache(contentHash: string, fingerprint: string): ragTelemetry.EnrichmentCacheValue | null {
    return ragTelemetry.getEnrichmentCache(this.db, contentHash, fingerprint);
  }
  putDocEnrichmentCache(contentHash: string, fingerprint: string, value: ragTelemetry.EnrichmentCacheValue): void {
    ragTelemetry.putEnrichmentCache(this.db, contentHash, fingerprint, value);
  }
  recordDocSearchEvent(input: ragTelemetry.DocSearchEventInput): void { ragTelemetry.recordSearchEvent(this.db, input); }
  recordDocSearchEvents(inputs: readonly ragTelemetry.DocSearchEventInput[]): void {
    ragTelemetry.recordSearchEvents(this.db, inputs);
  }

  // ─── FTS5 search ──────────────────────────────────────────────
  searchChunksFts(query: string, opts: { collectionId?: number; collectionIds?: readonly number[]; limit?: number } = {}): DocFtsHit[] { return fts.searchChunks(this.db, query, opts); }

  // ─── Project ↔ collection links (migration 134) ───────────────
  linkProjectCollection(projectId: number, collectionId: number, origin: DocProjectLinkOrigin = 'manual'): boolean { return projectLinks.link(this.db, projectId, collectionId, origin); }
  unlinkProjectCollection(projectId: number, collectionId: number): boolean { return projectLinks.unlink(this.db, projectId, collectionId); }
  listCollectionsForProject(projectId: number): DocCollection[] { return projectLinks.listCollectionsForProject(this.db, projectId); }
  listProjectsForCollection(collectionId: number): DocProjectLink[] { return projectLinks.listProjectsForCollection(this.db, collectionId); }

  // ─── Auto-discovery suggestions (migration 096) ───────────────
  upsertSuggestion(input: suggestions.UpsertSuggestionInput): boolean { return suggestions.upsert(this.db, input); }
  listSuggestions(opts: { projectId: number; status?: DocSuggestionStatus }): DocSourceSuggestion[] { return suggestions.list(this.db, opts); }
  getSuggestion(id: number): DocSourceSuggestion | null { return suggestions.get(this.db, id); }
  setSuggestionStatus(id: number, status: DocSuggestionStatus, indexedSourceId?: number | null): void { suggestions.setStatus(this.db, id, status, indexedSourceId); }
  deleteSuggestion(id: number): boolean { return suggestions.del(this.db, id); }
}
