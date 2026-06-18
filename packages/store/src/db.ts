import { runMigrations, getSchemaVersion } from './migrations/index.js';
import type {
  Project, DBFile, DBSymbol, IndexRun, CostSummary, ContextSnapshot, Webhook,
  FileSnapshot, VectorIdRecord, ProjectStats, DiscoveredModel, SnapshotCategory,
  SnapshotVersion, LLMSymbol, DBFileDependency, DBFileDependent,
  DBSymbolReference, DBSymbolRelation, RunKind,
} from '@mcp/shared/types.js';
import { Database, type DB, type PathAlias } from './db/types.js';
import { applyTuningPragmas } from './db/pragmas.js';
import { initSchema } from './db/schema/index.js';
import { repairCodeFtsIndexes } from './db/schema/fts.js';
import * as projects from './db/projects.js';
import * as files from './db/files.js';
import * as filesStructural from './db/files-structural.js';
import * as fileContents from './db/file-contents.js';
import * as symbols from './db/symbols.js';
import * as symbolRelations from './db/symbol-relations.js';
import * as runs from './db/runs.js';
import * as snapshots from './db/snapshots.js';
import * as snapshotsArchive from './db/snapshots-archive.js';
import * as memoryConsolidation from './db/memory-consolidation.js';
import * as memoryDistillLog from './db/memory-distill-log.js';
import * as costs from './db/costs.js';
import * as webhooks from './db/webhooks.js';
import * as vectors from './db/vectors.js';
import * as embeddings from './db/embeddings.js';
import * as modelsCache from './db/models-cache.js';
import * as stats from './db/stats.js';
import * as deps from './db/dependencies.js';
import * as maintenance from './db/maintenance.js';
import { loadTsconfigPathAliases } from './db/path-resolver.js';

export class CodeIndexDB {
  private db: DB;
  /** Cached tsconfig aliases per project id. Populated lazily. */
  private aliasCache = new Map<number, PathAlias[]>();

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = 10000');
    this.db.pragma('foreign_keys = ON');
    applyTuningPragmas(this.db);
    // Schema must exist before migrations that ALTER it.
    initSchema(this.db);
    runMigrations(this.db);
  }

  getSchemaVersion(): number { return getSchemaVersion(this.db); }
  /** better-sqlite3 handle for stores that need direct prepared-statement access. */
  raw(): DB { return this.db; }
  close(): void { this.db.close(); }
  /**
   * Run `fn` (synchronous) inside one SQLite transaction. Inner
   * `db.transaction` calls (files.upsert, symbols.upsert, …) become
   * savepoints, so composite persists commit or roll back as a unit.
   */
  transaction<T>(fn: () => T): T { return this.db.transaction(fn)(); }

  // ─── Projects ───────────────────────────────────────────────────
  createProject(name: string, rootPath: string, description?: string): Project { return projects.create(this.db, name, rootPath, description); }
  getProject(id: number): Project | undefined { return projects.get(this.db, id); }
  getProjectByName(name: string): Project | undefined { return projects.getByName(this.db, name); }
  getProjectByPath(rootPath: string): Project | undefined { return projects.getByPath(this.db, rootPath); }
  listProjects(): Project[] { return projects.list(this.db); }
  /** Synthetic global-session union projects (hidden from listProjects). */
  listSyntheticProjects(): Project[] { return projects.listSynthetic(this.db); }
  updateProject(id: number, updates: Parameters<typeof projects.update>[2]): void { projects.update(this.db, id, updates); }
  /** Mark a project as a synthetic global-session union (hidden from listProjects). */
  setProjectSynthetic(id: number, synthetic: boolean): void { projects.setSynthetic(this.db, id, synthetic); }
  deleteProject(id: number): void { projects.del(this.db, id); }
  /** Wipe a project's data (index/sessions/snapshots/runs/costs) but KEEP its row. */
  clearProjectData(id: number): void { projects.clearData(this.db, id); }
  /** Rebuild the code FTS5 indexes from the base tables — recovers SQLITE_CORRUPT_VTAB. */
  repairFtsIndexes(): void { repairCodeFtsIndexes(this.db); }
  resolveProject(name?: string, rootPath?: string): Project { return projects.resolve(this.db, name, rootPath); }

  // ─── Files ──────────────────────────────────────────────────────
  upsertFile(projectId: number, data: files.UpsertFileData): number { return files.upsert(this.db, projectId, data); }
  getFile(projectId: number, path: string): DBFile | undefined { return files.get(this.db, projectId, path); }
  getFileById(id: number): DBFile | undefined { return files.getById(this.db, id); }
  getFileByPath(projectId: number, path: string): DBFile | undefined { return files.get(this.db, projectId, path); }
  listFiles(projectId: number, language?: string): DBFile[] { return files.list(this.db, projectId, language); }
  listFileScanMeta(projectId: number): files.FileScanMeta[] { return files.listScanMeta(this.db, projectId); }
  touchFileMtime(projectId: number, path: string, mtimeMs: number): void { files.touchMtime(this.db, projectId, path, mtimeMs); }
  deleteFile(projectId: number, path: string): void { files.del(this.db, projectId, path); }
  deleteFilesByProject(projectId: number): void { files.delByProject(this.db, projectId); }
  searchFiles(projectId: number, query: string, limit: number = 20): DBFile[] { return files.search(this.db, projectId, query, limit); }
  saveFileSnapshot(data: files.FileSnapshotData): void { files.saveSnapshot(this.db, data); }
  getFileSnapshots(runId: number): FileSnapshot[] { return files.listSnapshots(this.db, runId); }

  // ─── Structural layer (migration 139/140) ───────────────────────
  /** Partial upsert that NEVER touches the semantic columns — see files-structural.ts. */
  upsertFileStructural(projectId: number, data: filesStructural.UpsertStructuralData): { fileId: number; created: boolean } { return filesStructural.upsertStructural(this.db, projectId, data); }
  setFileSemanticHash(projectId: number, path: string, contentHash: string): void { filesStructural.setSemanticHash(this.db, projectId, path, contentHash); }
  listSemanticStalePaths(projectId: number, limit?: number): string[] { return filesStructural.listSemanticStalePaths(this.db, projectId, limit); }
  countSemanticStale(projectId: number): number { return filesStructural.countSemanticStale(this.db, projectId); }
  upsertFileContent(fileId: number, content: string, sizeBytes?: number): boolean { return fileContents.upsertContent(this.db, fileId, content, sizeBytes); }
  removeFileContent(fileId: number): void { fileContents.removeContent(this.db, fileId); }
  searchFileContents(projectId: number, match: string, limit?: number): fileContents.ContentMatch[] { return fileContents.searchContent(this.db, projectId, match, limit); }
  missingContentFiles(projectId: number, limit?: number): Array<{ id: number; path: string }> { return fileContents.missingContentFiles(this.db, projectId, limit); }
  countFileContents(projectId: number): number { return fileContents.countContent(this.db, projectId); }

  // ─── Symbols ────────────────────────────────────────────────────
  upsertSymbols(projectId: number, fileId: number, filePath: string, syms: LLMSymbol[]): void { symbols.upsert(this.db, projectId, fileId, filePath, syms); }
  getSymbolById(id: number): DBSymbol | undefined { return symbols.getById(this.db, id); }
  getSymbolsByFile(projectId: number, filePath: string): DBSymbol[] { return symbols.getByFile(this.db, projectId, filePath); }
  /** Preferred entry for pinning to an exact symbol across re-indexes. */
  findSymbolByStableId(projectId: number, stableId: string): DBSymbol | undefined { return symbols.findByStableId(this.db, projectId, stableId); }
  findSymbolByName(projectId: number, name: string, opts?: symbols.FindSymbolOptions): DBSymbol | undefined { return symbols.findByName(this.db, projectId, name, opts); }
  findSymbolsByName(projectId: number, name: string, opts?: symbols.FindSymbolsOptions): DBSymbol[] { return symbols.findManyByName(this.db, projectId, name, opts); }
  getClassMembers(parentName: string, projectId: number): DBSymbol[] { return symbols.classMembers(this.db, parentName, projectId); }
  listAllSymbols(projectId: number): DBSymbol[] { return symbols.listAll(this.db, projectId); }
  searchSymbols(projectId: number, query: string, limit: number = 20): DBSymbol[] { return symbols.search(this.db, projectId, query, limit); }
  /** Identifier-prefix completion (b-tree range scan — see symbols.searchByPrefix). */
  searchSymbolsByPrefix(projectId: number, prefix: string, limit: number = 50, opts?: { exportedOnly?: boolean }): DBSymbol[] { return symbols.searchByPrefix(this.db, projectId, prefix, limit, opts); }
  listSymbolsByKind(projectId: number, kind: string, limit: number = 50): DBSymbol[] { return symbols.listByKind(this.db, projectId, kind, limit); }

  // ─── Symbol References & Relations ──────────────────────────────
  upsertSymbolReferences(projectId: number, fileId: number, filePath: string, references: symbolRelations.SymbolReferenceInput[]): void { symbolRelations.upsertReferences(this.db, projectId, fileId, filePath, references); }
  getSymbolReferences(symbolId: number): DBSymbolReference[] { return symbolRelations.getReferences(this.db, symbolId); }
  getSymbolCallers(projectId: number, symbolName: string): DBSymbolReference[] { return symbolRelations.getCallers(this.db, projectId, symbolName); }
  getSymbolRelations(symbolId: number): DBSymbolRelation[] { return symbolRelations.getRelations(this.db, symbolId); }
  getImplementors(projectId: number, interfaceName: string): DBSymbol[] { return symbolRelations.getImplementors(this.db, projectId, interfaceName); }
  getSubclasses(projectId: number, className: string): DBSymbol[] { return symbolRelations.getSubclasses(this.db, projectId, className); }
  getSymbolHierarchy(projectId: number, symbolName: string): symbolRelations.SymbolHierarchy { return symbolRelations.getHierarchy(this.db, projectId, symbolName); }
  traceSymbolUsage(projectId: number, symbolName: string, maxDepth: number = 3): symbolRelations.UsageTraceResult { return symbolRelations.traceUsage(this.db, projectId, symbolName, maxDepth); }

  // ─── Runs ───────────────────────────────────────────────────────
  startRun(projectId: number, provider?: string, model?: string, kind?: RunKind): number { return runs.start(this.db, projectId, provider, model, kind); }
  finishRun(runId: number, data: runs.FinishRunData): void { runs.finish(this.db, runId, data); }
  getRun(id: number): IndexRun | undefined { return runs.get(this.db, id); }
  getRuns(projectId: number, limit: number = 20): IndexRun[] { return runs.list(this.db, projectId, limit); }

  // ─── Snapshots ──────────────────────────────────────────────────
  createSnapshot(projectId: number, data: snapshots.CreateSnapshotData): ContextSnapshot { return snapshots.create(this.db, projectId, data); }
  markSnapshotAccessed(ids: number[]): void { snapshots.markAccessed(this.db, ids); }
  /** Per-project memory toggle (migration 115). Default ON. */
  getProjectMemoryEnabled(projectId: number): boolean {
    const row = this.db.prepare('SELECT memory_enabled FROM projects WHERE id = ?')
      .get(projectId) as { memory_enabled?: number } | undefined;
    return row?.memory_enabled !== 0;
  }
  setProjectMemoryEnabled(projectId: number, enabled: boolean): void {
    this.db.prepare('UPDATE projects SET memory_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, projectId);
  }
  setSnapshotFiles(snapshotId: number, projectId: number, filePaths: string[]): { inserted: number; skipped: string[] } { return snapshots.setFiles(this.db, snapshotId, projectId, filePaths); }
  getStaleSnapshotFiles(snapshotId: number, projectId: number): string[] { return snapshots.getStaleFiles(this.db, snapshotId, projectId); }
  getStaleSnapshotFilesBatch(ids: number[], projectId: number): Map<number, { stale: string[]; total: number }> { return snapshots.getStaleFilesBatch(this.db, ids, projectId); }
  getSnapshotFiles(snapshotId: number): string[] { return snapshots.getFiles(this.db, snapshotId); }
  updateSnapshot(id: number, updates: snapshots.UpdateSnapshotData): void { snapshots.update(this.db, id, updates); }
  updateSnapshotEmbeddingHash(id: number, hash: string): void { snapshots.updateEmbeddingHash(this.db, id, hash); }
  listSnapshotsMissingEmbedding(projectId?: number): ContextSnapshot[] { return snapshots.listMissingEmbedding(this.db, projectId); }
  countSnapshots(projectId: number): number { return snapshots.count(this.db, projectId); }
  countSnapshotVectors(projectId: number): number { return snapshots.countVectors(this.db, projectId); }
  deleteSnapshot(id: number): void { snapshots.del(this.db, id); }
  getSnapshotById(id: number): ContextSnapshot | undefined { return snapshots.getById(this.db, id); }
  listSnapshots(projectId: number, category?: SnapshotCategory): ContextSnapshot[] { return snapshots.list(this.db, projectId, category); }
  listMemoryIndex(projectId: number, limit = 12): snapshots.MemoryIndexEntry[] { return snapshots.listMemoryIndex(this.db, projectId, limit); }
  searchSnapshots(projectId: number, query: string): ContextSnapshot[] { return snapshots.search(this.db, projectId, query); }
  getSnapshotHistory(snapshotId: number): SnapshotVersion[] { return snapshots.getHistory(this.db, snapshotId); }
  // ─── Snapshot archive / merge (migration 146, memory consolidator) ──
  archiveSnapshot(id: number, reason: string): void { snapshotsArchive.archive(this.db, id, reason); }
  unarchiveSnapshot(id: number): void { snapshotsArchive.unarchive(this.db, id); }
  unionSnapshotFiles(winnerId: number, loserIds: number[]): void { snapshotsArchive.unionFiles(this.db, winnerId, loserIds); }
  setSnapshotAccessStats(id: number, accessCount: number, lastAccessedAt: string | null): void { snapshotsArchive.setAccessStats(this.db, id, accessCount, lastAccessedAt); }
  countArchivedSnapshots(projectId: number): number { return snapshotsArchive.countArchived(this.db, projectId); }
  listArchivedSnapshots(projectId: number, limit = 50): ContextSnapshot[] { return snapshotsArchive.listArchived(this.db, projectId, limit); }
  listConsolidationCandidates(idleSeconds: number, limit: number): memoryConsolidation.ConsolidationCandidate[] { return memoryConsolidation.listConsolidationCandidates(this.db, idleSeconds, limit); }

  // ─── Memory distillation diagnostics (migration 136) ────────────
  insertMemoryDistillLog(projectId: number, entry: memoryDistillLog.MemoryDistillLogEntry): void { memoryDistillLog.insert(this.db, projectId, entry); }
  latestMemoryDistill(projectId: number): memoryDistillLog.MemoryDistillLogRow | null { return memoryDistillLog.latestForProject(this.db, projectId); }
  recentMemoryDistills(projectId: number, limit = 20): memoryDistillLog.MemoryDistillLogRow[] { return memoryDistillLog.recentForProject(this.db, projectId, limit); }
  countMemoryByCategory(projectId: number): Record<string, number> { return memoryDistillLog.countSnapshotsByCategory(this.db, projectId); }
  countMemoryBySource(projectId: number): Record<string, number> { return memoryDistillLog.countSnapshotsBySource(this.db, projectId); }

  // ─── Costs ──────────────────────────────────────────────────────
  insertCost(data: costs.InsertCostData): void { costs.insert(this.db, data); }
  getCostSummary(projectId: number, since?: string): CostSummary { return costs.projectSummary(this.db, projectId, since); }
  getGlobalCostSummary(since?: string): CostSummary { return costs.globalSummary(this.db, since); }
  getRunCostSummary(runId: number): costs.RunCostSummary { return costs.runSummary(this.db, runId); }

  // ─── Webhooks ───────────────────────────────────────────────────
  createWebhook(data: webhooks.CreateWebhookData): Webhook { return webhooks.create(this.db, data); }
  listWebhooks(projectId?: number): Webhook[] { return webhooks.list(this.db, projectId); }
  deleteWebhook(id: number): void { webhooks.del(this.db, id); }
  getWebhooksForEvent(projectId: number, event: string): Webhook[] { return webhooks.forEvent(this.db, projectId, event); }
  updateWebhookStatus(id: number, statusCode: number): void { webhooks.updateStatus(this.db, id, statusCode); }

  // ─── Vector IDs ─────────────────────────────────────────────────
  saveVectorIds(projectId: number, vecs: vectors.VectorIdInput[]): void { vectors.save(this.db, projectId, vecs); }
  getVectorIdsByProject(projectId: number): VectorIdRecord[] { return vectors.listByProject(this.db, projectId); }
  deleteVectorIdsByProject(projectId: number): void { vectors.delByProject(this.db, projectId); }
  deleteVectorIdsByFile(projectId: number, filePath: string): string[] { return vectors.delByFile(this.db, projectId, filePath); }
  getVectorIdStats(projectId: number): { total: number; byType: Record<string, number> } { return vectors.stats(this.db, projectId); }
  snapshotVectorIdsForProject(projectId: number): string[] { return vectors.snapshotForProject(this.db, projectId); }
  getOrphanVectorIds(projectId: number): Array<{ vector_id: string; file_path: string | null; type: string }> { return vectors.listOrphans(this.db, projectId); }
  deleteVectorIdRows(projectId: number, vectorIds: string[]): number { return vectors.deleteRows(this.db, projectId, vectorIds); }
  dedupVectorIds(projectId?: number): number { return vectors.dedup(this.db, projectId); }
  countPendingVectorDeletes(): number { return vectors.countPendingDeletes(this.db); }
  enqueuePendingVectorDeletes(rows: vectors.PendingDeleteInput[]): number { return vectors.enqueuePendingDeletes(this.db, rows); }
  takePendingVectorDeletes(limit = 5000): Array<{ id: number; vector_id: string; project_name: string | null }> { return vectors.takePendingDeletes(this.db, limit); }
  deletePendingVectorDeletesByIds(ids: number[]): number { return vectors.deletePendingByIds(this.db, ids); }

  // ─── Embedding diagnostics & hashes ─────────────────────────────
  sampleEmbeddedFiles(projectId: number, limit = 5): Array<{ id: number; path: string; embedding_hash: string }> { return embeddings.sampleEmbeddedFiles(this.db, projectId, limit); }
  sampleNotEmbeddedFiles(projectId: number, limit = 5): Array<{ id: number; path: string }> { return embeddings.sampleNotEmbeddedFiles(this.db, projectId, limit); }
  getFileEmbeddingHashes(fileIds: number[]): Map<number, string | null> { return embeddings.getFileHashes(this.db, fileIds); }
  setFileEmbeddingHash(fileId: number, hash: string): void { embeddings.setFileHash(this.db, fileId, hash); }
  getFileStructureHash(projectId: number, path: string): string | null { return embeddings.getFileStructureHash(this.db, projectId, path); }
  setFileStructureHash(fileId: number, hash: string): void { embeddings.setFileStructureHash(this.db, fileId, hash); }
  getFileStructureEmbedding(projectId: number, path: string): Float32Array | null { return embeddings.getFileStructureEmbedding(this.db, projectId, path); }
  setFileStructureEmbedding(fileId: number, embedding: Float32Array): void { embeddings.setFileStructureEmbedding(this.db, fileId, embedding); }
  getSymbolEmbeddingHashes(symbolIds: number[]): Map<number, { sig: string | null; body: string | null }> { return embeddings.getSymbolHashes(this.db, symbolIds); }
  setSymbolEmbeddingHash(symbolId: number, hash: string, kind: 'sig' | 'body'): void { embeddings.setSymbolHash(this.db, symbolId, hash, kind); }
  getEmbeddingCoverage(projectId: number): embeddings.EmbeddingCoverage { return embeddings.coverage(this.db, projectId); }
  /** Null all embedding hashes for a project → next index re-embeds everything. */
  clearEmbeddingHashes(projectId: number): void { embeddings.clearHashes(this.db, projectId); }
  /** Embedding model/backend the project was last indexed with (migration 113). */
  getProjectEmbeddingFingerprint(projectId: number): string | null {
    const row = this.db.prepare('SELECT embedding_fingerprint FROM projects WHERE id = ?')
      .get(projectId) as { embedding_fingerprint: string | null } | undefined;
    return row?.embedding_fingerprint ?? null;
  }
  setProjectEmbeddingFingerprint(projectId: number, fingerprint: string): void {
    this.db.prepare('UPDATE projects SET embedding_fingerprint = ? WHERE id = ?').run(fingerprint, projectId);
  }

  // ─── Models Cache ───────────────────────────────────────────────
  getCachedModels(provider: string): DiscoveredModel[] | null { return modelsCache.get(this.db, provider); }
  setCachedModels(provider: string, models: DiscoveredModel[]): void { modelsCache.set(this.db, provider, models); }

  // ─── Stats & Architecture ───────────────────────────────────────
  getStats(projectId: number): ProjectStats { return stats.projectStats(this.db, projectId, this.getProject(projectId)); }
  listConcepts(projectId: number): Array<{ concept: string; count: number }> { return stats.listConcepts(this.db, projectId); }
  getFilesByConcept(projectId: number, concept: string): DBFile[] { return stats.getFilesByConcept(this.db, projectId, concept); }
  getLastTwoRunIds(projectId: number): [number, number] | null { return stats.getLastTwoRunIds(this.db, projectId); }
  getFilesByLayer(projectId: number, layer: string): DBFile[] { return stats.getFilesByLayer(this.db, projectId, layer); }
  getArchitectureOverview(projectId: number): Array<{ layer: string; count: number }> { return stats.getArchitectureOverview(this.db, projectId); }

  // ─── Dependencies ───────────────────────────────────────────────
  upsertFileDependencies(projectId: number, sourceFileId: number, sourceFilePath: string, internalDeps: string[], externalDeps: string[]): void {
    deps.upsert(this.db, projectId, sourceFileId, sourceFilePath, internalDeps, externalDeps, this.getAliases(projectId));
  }
  getDependencies(fileId: number): DBFileDependency[] { return deps.getDependencies(this.db, fileId); }
  getDependents(projectId: number, fileId: number): DBFileDependent[] { return deps.getDependents(this.db, projectId, fileId); }
  getCircularDeps(projectId: number): Array<{ path_a: string; path_b: string }> { return deps.getCircular(this.db, projectId); }
  /** Invalidate alias cache (e.g. after re-index when tsconfig may have changed). */
  clearAliasCache(projectId?: number): void {
    if (projectId === undefined) this.aliasCache.clear();
    else this.aliasCache.delete(projectId);
  }

  // ─── Maintenance / Hygiene ──────────────────────────────────────
  getProjectsHygiene(): maintenance.ProjectHygieneRow[] { return maintenance.listProjectsHygiene(this.db); }
  getFileIndegrees(projectId: number): Map<string, number> { return maintenance.getFileIndegrees(this.db, projectId); }
  getProjectTierBreakdown(): Array<{ project_id: number; tier: string; count: number }> { return maintenance.getProjectTierBreakdown(this.db); }
  normalizeFileLanguages(projectId?: number): number { return maintenance.normalizeFileLanguages(this.db, projectId); }
  markStaleRuns(olderThanHours = 2, projectId?: number): number { return maintenance.markStaleRuns(this.db, olderThanHours, projectId); }
  setProjectPendingVectorGc(projectId: number, pending: boolean): void { maintenance.setProjectPendingVectorGc(this.db, projectId, pending); }

  private getAliases(projectId: number): PathAlias[] {
    const cached = this.aliasCache.get(projectId);
    if (cached) return cached;
    const project = this.getProject(projectId);
    const aliases = project ? loadTsconfigPathAliases(project.root_path) : [];
    this.aliasCache.set(projectId, aliases);
    return aliases;
  }
}
