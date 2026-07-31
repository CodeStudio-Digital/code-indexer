/** Central control-plane persistence for distributed semantic indexes. */
import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;

/** Independent build domains. They may share the same configured target and
 * worker session, but never share generation locks or rollout state. */
export type SemanticPurpose = 'code' | 'docs' | 'memory';
export type SemanticCapability = 'embedding' | 'rerank';

export function semanticPurposeForNamespace(namespace: string): SemanticPurpose {
  if (/^code:p\d+$/.test(namespace)) return 'code';
  if (/^docs:c\d+$/.test(namespace)) return 'docs';
  if (/^(?:snapshot:p\d+|memory:project:p\d+|memory:user)$/.test(namespace)) return 'memory';
  throw new Error(`Unsupported semantic namespace: ${namespace}`);
}

type MemoryNamespaceSource =
  | { scope: 'user'; projectId: 0 }
  | { scope: 'project'; projectId: number };

function memoryNamespaceSource(namespace: string): MemoryNamespaceSource | null {
  if (namespace === 'memory:user') return { scope: 'user', projectId: 0 };
  const match = /^memory:project:p(\d+)$/.exec(namespace);
  if (!match) return null;
  const projectId = Number(match[1]);
  return Number.isSafeInteger(projectId) && projectId > 0
    ? { scope: 'project', projectId }
    : null;
}

/** Dtypes accepted by the managed transformers.js ONNX runtime. `q8` is the
 * local default: it keeps the desktop memory envelope predictable while the
 * complete target remains pinned in the generation fingerprint. */
export type SemanticOnnxDtype = 'q8' | 'q4' | 'fp16' | 'fp32';

export type EmbeddingTarget =
  | {
      kind: 'onnx';
      model: string;
      revision?: string;
      cacheDir?: string;
      dtype?: SemanticOnnxDtype;
      pooling: 'mean' | 'cls';
      normalize: boolean;
      queryTemplate: string;
      documentTemplate: string;
      maxTokens?: number;
    }
  | {
      kind: 'local_http';
      baseUrl: string;
      model: string;
      protocol: 'openai-embeddings';
    }
  | {
      kind: 'provider';
      providerId: string;
      model: string;
      protocol: 'openai-embeddings' | 'cloudflare' | 'bedrock';
    }
  | { kind: 'disabled' };

export type RerankerTarget =
  | {
      kind: 'onnx';
      /** `auto` resolves per-machine in the semantic worker and never changes
       * an embedding generation because rerankers do not define vector space. */
      model: 'auto' | (string & {});
      revision?: string;
      cacheDir?: string;
      dtype?: SemanticOnnxDtype;
      maxTokens?: number;
    }
  | {
      kind: 'local_http';
      baseUrl: string;
      model: string;
      protocol: 'cohere-rerank' | 'openai-rerank';
    }
  | {
      kind: 'provider';
      providerId: string;
      model: string;
      protocol: 'cohere-rerank' | 'openai-rerank' | 'cloudflare' | 'bedrock';
    }
  | { kind: 'disabled' };

export interface SemanticProfileRow {
  purpose: SemanticPurpose;
  embedding_target: EmbeddingTarget;
  reranker_target: RerankerTarget;
  created_at: string;
  updated_at: string;
}

export type SemanticGenerationStatus = 'building' | 'ready' | 'failed' | 'retired';
export interface SemanticGenerationRow {
  id: number;
  purpose: SemanticPurpose;
  fingerprint: string;
  embedding_target: EmbeddingTarget;
  dimension: number;
  status: SemanticGenerationStatus;
  expected_items: number;
  indexed_items: number;
  failed_items: number;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface SemanticNamespaceGenerationRow {
  namespace: string;
  purpose: SemanticPurpose;
  active_generation_id: number | null;
  building_generation_id: number | null;
  expected_items: number;
  indexed_items: number;
  failed_items: number;
  delta_items: number;
  last_error: string | null;
  updated_at: string;
}

export type SemanticModelStatus = 'unknown' | 'ready' | 'error';
export interface SemanticModelCatalogRow {
  id: string;
  capability: SemanticCapability;
  source: 'default' | 'detected' | 'custom';
  provider_id: string | null;
  model_id: string;
  config: Record<string, unknown>;
  dimension: number | null;
  status: SemanticModelStatus;
  last_probe_at: string | null;
  last_probe_error: string | null;
  created_at: string;
  updated_at: string;
}

export type SemanticItemStatus = 'pending' | 'indexed' | 'failed' | 'stale';
export interface SemanticItemRow {
  generation_id: number;
  namespace: string;
  item_key: string;
  source_hash: string;
  vector_id: string | null;
  chunk_index: number;
  status: SemanticItemStatus;
  attempts: number;
  error: string | null;
  updated_at: string;
}

export type SemanticJobKind = 'build' | 'backfill' | 'delta' | 'cleanup';
export type SemanticJobStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export const PROJECT_REMOVAL_NAMESPACE_PREFIX = 'project-removal:p';

export function projectRemovalNamespace(projectId: number): string {
  if (!Number.isSafeInteger(projectId) || projectId < 1) {
    throw new Error(`Invalid project id for semantic removal: ${projectId}`);
  }
  return `${PROJECT_REMOVAL_NAMESPACE_PREFIX}${projectId}`;
}

export function projectIdFromRemovalNamespace(namespace: string): number | null {
  const match = /^project-removal:p(\d+)$/.exec(namespace);
  if (!match) return null;
  const projectId = Number(match[1]);
  return Number.isSafeInteger(projectId) && projectId > 0 ? projectId : null;
}

export interface SemanticJobRow {
  id: number;
  generation_id: number | null;
  namespace: string;
  kind: SemanticJobKind;
  status: SemanticJobStatus;
  priority: number;
  cursor: Record<string, unknown> | null;
  expected_items: number;
  processed_items: number;
  failed_items: number;
  error: string | null;
  created_at: string;
  started_at: string | null;
  updated_at: string;
  completed_at: string | null;
}

export interface SemanticMutationInput {
  namespace: string;
  itemKeys: readonly string[];
  operation: 'upsert' | 'delete';
  /** Keep serving on lexical sources until an operator explicitly rebuilds
   * this namespace. Used when a structural scan can prove drift but cannot
   * enumerate exact semantic paths without a whole-project content read. */
  requiresExplicitReindex?: boolean;
  /** Optional durable fence for a relational mutation that has not settled
   * yet. Fences are never coalesced: one running job represents one caller,
   * allowing concurrent documentation sources to block activation
   * independently until each caller reaches its `finally` block. */
  fence?: {
    token: string;
    owner: string;
    /** Optional cross-process lease. A new server must not recover a fence
     * owned by a still-running CLI/MCP writer merely because its owner id is
     * different from the server process. */
    leaseMs?: number;
  };
}

export interface CapturedSemanticMutationJob {
  id: number;
  expected_items: number;
}

export interface SemanticMutationPassResult {
  state: SemanticNamespaceGenerationRow;
  pending: boolean;
  activated: boolean;
  completed_job_ids: number[];
}

export interface SemanticStatus {
  profiles: SemanticProfileRow[];
  generations: SemanticGenerationRow[];
  namespaces: SemanticNamespaceGenerationRow[];
  jobs: Record<SemanticJobStatus, number>;
  totals: {
    expected_items: number;
    indexed_items: number;
    failed_items: number;
    delta_items: number;
  };
}

type JsonProfileRow = Omit<SemanticProfileRow, 'embedding_target' | 'reranker_target'> & {
  embedding_target: string;
  reranker_target: string;
};
type JsonGenerationRow = Omit<SemanticGenerationRow, 'embedding_target'> & { embedding_target: string };
type JsonModelRow = Omit<SemanticModelCatalogRow, 'config'> & { config: string };
type JsonJobRow = Omit<SemanticJobRow, 'cursor'> & { cursor: string | null };

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function withEmbeddingDefaults(target: EmbeddingTarget): EmbeddingTarget {
  return target.kind === 'onnx' && target.dtype === undefined
    ? { ...target, dtype: 'q8' }
    : target;
}

function withRerankerDefaults(target: RerankerTarget): RerankerTarget {
  return target.kind === 'onnx' && target.dtype === undefined
    ? { ...target, dtype: 'q8' }
    : target;
}

function hydrateProfile(row: JsonProfileRow): SemanticProfileRow {
  return {
    ...row,
    embedding_target: withEmbeddingDefaults(parseJson<EmbeddingTarget>(row.embedding_target)),
    reranker_target: withRerankerDefaults(parseJson<RerankerTarget>(row.reranker_target)),
  };
}

function hydrateGeneration(row: JsonGenerationRow): SemanticGenerationRow {
  return {
    ...row,
    embedding_target: withEmbeddingDefaults(parseJson<EmbeddingTarget>(row.embedding_target)),
  };
}

function hydrateModel(row: JsonModelRow): SemanticModelCatalogRow {
  return { ...row, config: parseJson<Record<string, unknown>>(row.config) };
}

function hydrateJob(row: JsonJobRow): SemanticJobRow {
  return { ...row, cursor: row.cursor ? parseJson<Record<string, unknown>>(row.cursor) : null };
}

export class SemanticStore {
  private readonly db: DB;
  private readonly ownsConnection: boolean;

  constructor(
    dbPathOrInstance: string | DB,
    options: { busyTimeoutMs?: number } = {},
  ) {
    if (typeof dbPathOrInstance === 'string') {
      this.db = new Database(dbPathOrInstance);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.ownsConnection = true;
    } else {
      this.db = dbPathOrInstance;
      this.ownsConnection = false;
    }
    if (options.busyTimeoutMs != null) {
      const timeout = Math.max(0, Math.trunc(options.busyTimeoutMs));
      this.db.pragma(`busy_timeout = ${timeout}`);
    }
  }

  /**
   * Run a small main-thread mutation with a connection-local busy ceiling.
   * SQLite's busy timeout is otherwise 5s, which is appropriate in workers but
   * can freeze Electron-main when a structural writer owns the central DB.
   * The previous value is restored even when SQLite throws.
   */
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

  close(): void {
    if (this.ownsConnection) this.db.close();
  }

  listProfiles(): SemanticProfileRow[] {
    return (this.db.prepare(`SELECT * FROM semantic_profiles ORDER BY purpose`).all() as JsonProfileRow[])
      .map(hydrateProfile);
  }

  getProfile(purpose: SemanticPurpose): SemanticProfileRow | null {
    const row = this.db.prepare(`SELECT * FROM semantic_profiles WHERE purpose = ?`).get(purpose) as
      | JsonProfileRow
      | undefined;
    return row ? hydrateProfile(row) : null;
  }

  upsertProfile(input: {
    purpose: SemanticPurpose;
    embedding_target: EmbeddingTarget;
    reranker_target: RerankerTarget;
  }): SemanticProfileRow {
    this.db.prepare(`
      INSERT INTO semantic_profiles (purpose, embedding_target, reranker_target)
      VALUES (?, ?, ?)
      ON CONFLICT(purpose) DO UPDATE SET
        embedding_target = excluded.embedding_target,
        reranker_target = excluded.reranker_target,
        updated_at = datetime('now')
    `).run(input.purpose, JSON.stringify(input.embedding_target), JSON.stringify(input.reranker_target));
    return this.getProfile(input.purpose)!;
  }

  listModels(filter: { capability?: SemanticCapability; source?: SemanticModelCatalogRow['source'] } = {}): SemanticModelCatalogRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.capability) { where.push('capability = ?'); params.push(filter.capability); }
    if (filter.source) { where.push('source = ?'); params.push(filter.source); }
    const sql = `SELECT * FROM semantic_model_catalog${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
      ORDER BY capability, source, model_id`;
    return (this.db.prepare(sql).all(...params) as JsonModelRow[]).map(hydrateModel);
  }

  upsertModel(input: {
    id: string;
    capability: SemanticCapability;
    source: SemanticModelCatalogRow['source'];
    provider_id?: string | null;
    model_id: string;
    config?: Record<string, unknown>;
    dimension?: number | null;
    status?: SemanticModelStatus;
    last_probe_error?: string | null;
  }): SemanticModelCatalogRow {
    this.db.prepare(`
      INSERT INTO semantic_model_catalog
        (id, capability, source, provider_id, model_id, config, dimension, status, last_probe_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        capability = excluded.capability, source = excluded.source,
        provider_id = excluded.provider_id, model_id = excluded.model_id,
        config = excluded.config, dimension = excluded.dimension,
        status = excluded.status, last_probe_error = excluded.last_probe_error,
        updated_at = datetime('now')
    `).run(
      input.id, input.capability, input.source, input.provider_id ?? null, input.model_id,
      JSON.stringify(input.config ?? {}), input.dimension ?? null, input.status ?? 'unknown',
      input.last_probe_error ?? null,
    );
    const row = this.db.prepare(`SELECT * FROM semantic_model_catalog WHERE id = ?`).get(input.id) as JsonModelRow;
    return hydrateModel(row);
  }

  recordModelProbe(id: string, result: { ok: boolean; dimension?: number | null; error?: string | null }): SemanticModelCatalogRow | null {
    this.db.prepare(`
      UPDATE semantic_model_catalog SET
        status = ?, dimension = COALESCE(?, dimension), last_probe_at = datetime('now'),
        last_probe_error = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(result.ok ? 'ready' : 'error', result.dimension ?? null, result.ok ? null : (result.error ?? 'probe failed'), id);
    const row = this.db.prepare(`SELECT * FROM semantic_model_catalog WHERE id = ?`).get(id) as JsonModelRow | undefined;
    return row ? hydrateModel(row) : null;
  }

  deleteModel(id: string): number {
    return this.db.prepare(`DELETE FROM semantic_model_catalog WHERE id = ?`).run(id).changes;
  }

  listGenerations(filter: { purpose?: SemanticPurpose; status?: SemanticGenerationStatus } = {}): SemanticGenerationRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.purpose) { where.push('purpose = ?'); params.push(filter.purpose); }
    if (filter.status) { where.push('status = ?'); params.push(filter.status); }
    const sql = `SELECT * FROM semantic_generations${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC`;
    return (this.db.prepare(sql).all(...params) as JsonGenerationRow[]).map(hydrateGeneration);
  }

  getGeneration(id: number): SemanticGenerationRow | null {
    const row = this.db.prepare(`SELECT * FROM semantic_generations WHERE id = ?`).get(id) as
      | JsonGenerationRow
      | undefined;
    return row ? hydrateGeneration(row) : null;
  }

  /**
   * Resolve the immutable embedding snapshot currently serving one namespace.
   * `semantic_profiles` is only the desired configuration for the next build;
   * query-time code must never read it to embed against already-stored vectors.
   */
  getActiveGeneration(namespace: string): SemanticGenerationRow | null {
    const row = this.db.prepare(`
      SELECT generation.*
      FROM semantic_namespace_generations AS namespace
      JOIN semantic_generations AS generation
        ON generation.id = namespace.active_generation_id
      WHERE namespace.namespace = ?
    `).get(namespace) as JsonGenerationRow | undefined;
    return row ? hydrateGeneration(row) : null;
  }

  /** Resolve the immutable generation currently accepting writes for one
   * namespace. A replacement under construction takes precedence over the
   * active generation, matching LocalVectorRouter's write policy. */
  getWriteGeneration(namespace: string): SemanticGenerationRow | null {
    const row = this.db.prepare(`
      SELECT generation.*
      FROM semantic_namespace_generations AS namespace
      JOIN semantic_generations AS generation
        ON generation.id = COALESCE(
          namespace.building_generation_id,
          namespace.active_generation_id
        )
      WHERE namespace.namespace = ?
    `).get(namespace) as JsonGenerationRow | undefined;
    return row ? hydrateGeneration(row) : null;
  }

  createGeneration(input: {
    purpose: SemanticPurpose;
    fingerprint: string;
    embedding_target: EmbeddingTarget;
    dimension: number;
    expected_items?: number;
  }): SemanticGenerationRow {
    const info = this.db.prepare(`
      INSERT INTO semantic_generations
        (purpose, fingerprint, embedding_target, dimension, expected_items, status, started_at)
      VALUES (?, ?, ?, ?, ?, 'building', datetime('now'))
    `).run(
      input.purpose, input.fingerprint, JSON.stringify(input.embedding_target),
      input.dimension, input.expected_items ?? 0,
    );
    const row = this.db.prepare(`SELECT * FROM semantic_generations WHERE id = ?`)
      .get(Number(info.lastInsertRowid)) as JsonGenerationRow;
    return hydrateGeneration(row);
  }

  updateGeneration(id: number, patch: {
    status?: SemanticGenerationStatus;
    expected_items?: number;
    indexed_items?: number;
    failed_items?: number;
    error?: string | null;
  }): SemanticGenerationRow | null {
    const current = this.getGeneration(id);
    if (!current) return null;
    const status = patch.status ?? current.status;
    const completed = status === 'ready' || status === 'failed' || status === 'retired';
    this.db.prepare(`
      UPDATE semantic_generations SET status = ?, expected_items = ?, indexed_items = ?,
        failed_items = ?, error = ?, completed_at = CASE
          WHEN ? = 'building' THEN NULL
          WHEN ? THEN datetime('now')
          ELSE completed_at
        END
      WHERE id = ?
    `).run(
      status, patch.expected_items ?? current.expected_items, patch.indexed_items ?? current.indexed_items,
      patch.failed_items ?? current.failed_items, patch.error === undefined ? current.error : patch.error,
      status, completed ? 1 : 0, id,
    );
    return this.getGeneration(id);
  }

  listNamespaceGenerations(filter: { purpose?: SemanticPurpose; namespace?: string } = {}): SemanticNamespaceGenerationRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.purpose) { where.push('purpose = ?'); params.push(filter.purpose); }
    if (filter.namespace) { where.push('namespace = ?'); params.push(filter.namespace); }
    const sql = `SELECT * FROM semantic_namespace_generations${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
      ORDER BY namespace`;
    return this.db.prepare(sql).all(...params) as SemanticNamespaceGenerationRow[];
  }

  beginNamespaceGeneration(input: {
    namespace: string;
    purpose: SemanticPurpose;
    generation_id: number;
    expected_items?: number;
  }): SemanticNamespaceGenerationRow {
    const generation = this.getGeneration(input.generation_id);
    if (!generation || generation.purpose !== input.purpose) {
      throw new Error(`Generation ${input.generation_id} does not belong to ${input.purpose}`);
    }
    this.db.prepare(`
      INSERT INTO semantic_namespace_generations
        (namespace, purpose, building_generation_id, expected_items)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(namespace) DO UPDATE SET
        purpose = excluded.purpose, building_generation_id = excluded.building_generation_id,
        expected_items = excluded.expected_items, indexed_items = 0, failed_items = 0,
        delta_items = 0, last_error = NULL, updated_at = datetime('now')
    `).run(input.namespace, input.purpose, input.generation_id, input.expected_items ?? 0);
    return this.listNamespaceGenerations({ namespace: input.namespace })[0];
  }

  updateNamespaceProgress(namespace: string, patch: {
    expected_items?: number;
    indexed_items?: number;
    failed_items?: number;
    delta_items?: number;
    last_error?: string | null;
  }): SemanticNamespaceGenerationRow | null {
    const current = this.listNamespaceGenerations({ namespace })[0];
    if (!current) return null;
    this.db.prepare(`
      UPDATE semantic_namespace_generations SET expected_items = ?, indexed_items = ?,
        failed_items = ?, delta_items = ?, last_error = ?, updated_at = datetime('now')
      WHERE namespace = ?
    `).run(
      patch.expected_items ?? current.expected_items, patch.indexed_items ?? current.indexed_items,
      patch.failed_items ?? current.failed_items, patch.delta_items ?? current.delta_items,
      patch.last_error === undefined ? current.last_error : patch.last_error, namespace,
    );
    return this.listNamespaceGenerations({ namespace })[0];
  }

  /** Clear an abandoned construction pointer only when it still references
   * the generation that was physically dropped. The compare-and-clear keeps
   * a concurrent replacement from being detached accidentally. */
  clearBuildingGeneration(
    namespace: string,
    generationId: number,
    lastError: string | null = null,
  ): SemanticNamespaceGenerationRow | null {
    this.db.prepare(`
      UPDATE semantic_namespace_generations
      SET building_generation_id = NULL, delta_items = 0, last_error = ?,
        updated_at = datetime('now')
      WHERE namespace = ? AND building_generation_id = ?
    `).run(lastError, namespace, generationId);
    return this.listNamespaceGenerations({ namespace })[0] ?? null;
  }

  /** Atomically switch a namespace only after its complete, error-free build. */
  activateNamespaceGeneration(namespace: string, generationId: number): SemanticNamespaceGenerationRow {
    return this.db.transaction(() => {
      const state = this.listNamespaceGenerations({ namespace })[0];
      const generation = this.getGeneration(generationId);
      if (!state || state.building_generation_id !== generationId) {
        throw new Error(`Generation ${generationId} is not building for ${namespace}`);
      }
      // A generation rolls out atomically per namespace, so it can already
      // serve completed namespaces while the global rollout is still marked
      // building. The coordinator marks it ready only after every target
      // namespace has completed its logical + physical coverage gate.
      if (!generation || (generation.status !== 'building' && generation.status !== 'ready')) {
        throw new Error(`Generation ${generationId} is not activatable`);
      }
      if (state.failed_items > 0 || state.delta_items > 0 || state.indexed_items < state.expected_items) {
        throw new Error(`Namespace ${namespace} is incomplete`);
      }
      this.db.prepare(`
        UPDATE semantic_namespace_generations SET active_generation_id = ?,
          building_generation_id = NULL, last_error = NULL, updated_at = datetime('now')
        WHERE namespace = ?
      `).run(generationId, namespace);
      return this.listNamespaceGenerations({ namespace })[0];
    })();
  }

  retireUnreferencedGenerations(purpose?: SemanticPurpose): number {
    const result = this.db.prepare(`
      UPDATE semantic_generations SET status = 'retired', completed_at = COALESCE(completed_at, datetime('now'))
      WHERE status = 'ready' ${purpose ? 'AND purpose = ?' : ''}
        AND id NOT IN (
          SELECT active_generation_id FROM semantic_namespace_generations WHERE active_generation_id IS NOT NULL
          UNION SELECT building_generation_id FROM semantic_namespace_generations WHERE building_generation_id IS NOT NULL
        )
    `).run(...(purpose ? [purpose] : []));
    return result.changes;
  }

  /** Historical namespaces are the routing evidence needed to locate an old
   * generation table after active/building pointers have moved on. */
  listGenerationNamespaces(generationId: number): string[] {
    const rows = this.db.prepare(`
      SELECT namespace FROM semantic_items WHERE generation_id = ?
      UNION
      SELECT namespace FROM semantic_jobs WHERE generation_id = ?
      ORDER BY namespace
    `).all(generationId, generationId) as Array<{ namespace: string }>;
    return rows.map((row) => row.namespace);
  }

  deleteNamespace(namespace: string): { items: number; jobs: number; namespace: number } {
    return this.db.transaction(() => {
      const state = this.listNamespaceGenerations({ namespace })[0];
      const jobs = this.db.prepare(`DELETE FROM semantic_jobs WHERE namespace = ?`).run(namespace).changes;
      const items = this.db.prepare(`DELETE FROM semantic_items WHERE namespace = ?`).run(namespace).changes;
      const removed = this.db.prepare(`DELETE FROM semantic_namespace_generations WHERE namespace = ?`).run(namespace).changes;
      for (const id of [state?.active_generation_id, state?.building_generation_id]) {
        if (!id) continue;
        this.db.prepare(`
          UPDATE semantic_generations SET status = 'retired', completed_at = COALESCE(completed_at, datetime('now'))
          WHERE id = ? AND status IN ('building', 'ready')
            AND NOT EXISTS (
              SELECT 1 FROM semantic_namespace_generations
              WHERE active_generation_id = ? OR building_generation_id = ?
            )
        `).run(id, id, id);
      }
      return { items, jobs, namespace: removed };
    })();
  }

  upsertItem(input: Omit<SemanticItemRow, 'updated_at'>): SemanticItemRow {
    this.db.prepare(`
      INSERT INTO semantic_items
        (generation_id, namespace, item_key, source_hash, vector_id, chunk_index, status, attempts, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(generation_id, namespace, item_key, chunk_index) DO UPDATE SET
        source_hash = excluded.source_hash, vector_id = excluded.vector_id,
        status = excluded.status,
        attempts = semantic_items.attempts + excluded.attempts,
        error = excluded.error,
        updated_at = datetime('now')
    `).run(
      input.generation_id, input.namespace, input.item_key, input.source_hash,
      input.vector_id, input.chunk_index, input.status, input.attempts, input.error,
    );
    return this.db.prepare(`
      SELECT * FROM semantic_items
      WHERE generation_id = ? AND namespace = ? AND item_key = ? AND chunk_index = ?
    `).get(input.generation_id, input.namespace, input.item_key, input.chunk_index) as SemanticItemRow;
  }

  listItems(filter: {
    generation_id: number;
    namespace?: string;
    status?: SemanticItemStatus;
    item_keys?: readonly string[];
  }): SemanticItemRow[] {
    if (filter.item_keys?.length === 0) return [];
    if (filter.item_keys && filter.item_keys.length > 500) {
      const rows: SemanticItemRow[] = [];
      for (let offset = 0; offset < filter.item_keys.length; offset += 500) {
        rows.push(...this.listItems({
          ...filter,
          item_keys: filter.item_keys.slice(offset, offset + 500),
        }));
      }
      return rows.sort((a, b) =>
        a.namespace.localeCompare(b.namespace)
        || a.item_key.localeCompare(b.item_key)
        || a.chunk_index - b.chunk_index);
    }
    const where = ['generation_id = ?'];
    const params: unknown[] = [filter.generation_id];
    if (filter.namespace) { where.push('namespace = ?'); params.push(filter.namespace); }
    if (filter.status) { where.push('status = ?'); params.push(filter.status); }
    if (filter.item_keys) {
      where.push(`item_key IN (${filter.item_keys.map(() => '?').join(',')})`);
      params.push(...filter.item_keys);
    }
    return this.db.prepare(
      `SELECT * FROM semantic_items WHERE ${where.join(' AND ')} ORDER BY namespace, item_key, chunk_index`,
    ).all(...params) as SemanticItemRow[];
  }

  deleteItemsByVectorIds(generationId: number, namespace: string, vectorIds: string[]): number {
    if (vectorIds.length === 0) return 0;
    let deleted = 0;
    const stmt = this.db.prepare(`
      DELETE FROM semantic_items
      WHERE generation_id = ? AND namespace = ? AND vector_id = ?
    `);
    this.db.transaction((ids: string[]) => {
      for (const id of ids) deleted += stmt.run(generationId, namespace, id).changes;
    })(vectorIds);
    return deleted;
  }

  deleteItemsByItemKeys(generationId: number, namespace: string, itemKeys: readonly string[]): number {
    if (itemKeys.length === 0) return 0;
    let deleted = 0;
    const stmt = this.db.prepare(`
      DELETE FROM semantic_items
      WHERE generation_id = ? AND namespace = ? AND item_key = ?
    `);
    this.db.transaction((keys: readonly string[]) => {
      for (const key of new Set(keys)) deleted += stmt.run(generationId, namespace, key).changes;
    })(itemKeys);
    return deleted;
  }

  deleteItemsForNamespaceGeneration(generationId: number, namespace: string): number {
    return this.db.prepare(`
      DELETE FROM semantic_items WHERE generation_id = ? AND namespace = ?
    `).run(generationId, namespace).changes;
  }

  createJob(input: {
    generation_id?: number | null;
    namespace: string;
    kind: SemanticJobKind;
    priority?: number;
    cursor?: Record<string, unknown> | null;
    expected_items?: number;
  }): SemanticJobRow {
    const info = this.db.prepare(`
      INSERT INTO semantic_jobs
        (generation_id, namespace, kind, priority, cursor, expected_items)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.generation_id ?? null, input.namespace, input.kind, input.priority ?? 0,
      input.cursor ? JSON.stringify(input.cursor) : null, input.expected_items ?? 0,
    );
    return this.getJob(Number(info.lastInsertRowid))!;
  }

  /**
   * Capture source identities before an INSERT whose row id is not known yet.
   * The settled fence can then replace `*` with only rows above these durable
   * watermarks. This keeps the activation barrier pre-write without turning
   * every learned memory/investigation into a namespace-wide reconciliation.
   */
  private memorySourceWatermark(namespace: string): Record<string, number> | null {
    const source = memoryNamespaceSource(namespace);
    if (!source) return null;
    try {
      const memory = source.scope === 'user'
        ? this.db.prepare(`
            SELECT COALESCE(MAX(id), 0) AS id
            FROM agent_memory
            WHERE scope = 'user' AND project_id = 0
          `).get() as { id: number }
        : this.db.prepare(`
            SELECT COALESCE(MAX(id), 0) AS id
            FROM agent_memory
            WHERE scope IN ('project', 'local') AND project_id = ?
          `).get(source.projectId) as { id: number };
      if (source.scope === 'user') {
        return { agent_memory_max_id: Number(memory.id) || 0 };
      }
      const investigation = this.db.prepare(`
        SELECT COALESCE(MAX(id), 0) AS id
        FROM coder_investigations
        WHERE project_id = ?
      `).get(source.projectId) as { id: number };
      return {
        agent_memory_max_id: Number(memory.id) || 0,
        investigation_max_id: Number(investigation.id) || 0,
      };
    } catch {
      // Older/trimmed databases may not contain both relational sources.
      // Keeping the wildcard preserves correctness during migration/recovery.
      return null;
    }
  }

  private memoryRowBelongsToNamespace(
    row: { scope: string; project_id: number; archived_at: string | null } | undefined,
    source: MemoryNamespaceSource,
  ): boolean {
    if (!row || row.archived_at !== null) return false;
    if (source.scope === 'user') return row.scope === 'user' && row.project_id === 0;
    return (row.scope === 'project' || row.scope === 'local')
      && row.project_id === source.projectId;
  }

  /**
   * Resolve a Memory fence after the relational write is visible. Wildcards
   * become post-watermark INSERT identities; exact delete fences shrink to
   * rows that actually left the live source set. Returning null deliberately
   * retains the wildcard/full-reconciliation recovery path.
   */
  private resolveMemoryMutationFence(job: SemanticJobRow): {
    cursor: Record<string, unknown>;
    expectedItems: number;
  } | null {
    const source = memoryNamespaceSource(job.namespace);
    if (!source || job.cursor?.fence_identity_resolved === true) return null;
    const rawKeys = Array.isArray(job.cursor?.item_keys)
      ? job.cursor.item_keys.filter((value): value is string => typeof value === 'string')
      : [];
    const wildcard = rawKeys.includes('*');
    const resolved = new Set(rawKeys.filter((key) => key !== '*'));

    try {
      if (wildcard) {
        const watermark = job.cursor?.memory_source_watermark;
        if (!watermark || typeof watermark !== 'object') return null;
        const values = watermark as Record<string, unknown>;
        const memoryMaxId = Number(values.agent_memory_max_id);
        if (!Number.isSafeInteger(memoryMaxId) || memoryMaxId < 0) return null;
        const memories = source.scope === 'user'
          ? this.db.prepare(`
              SELECT id FROM agent_memory
              WHERE scope = 'user' AND project_id = 0 AND id > ?
              ORDER BY id
            `).all(memoryMaxId) as Array<{ id: number }>
          : this.db.prepare(`
              SELECT id FROM agent_memory
              WHERE scope IN ('project', 'local') AND project_id = ? AND id > ?
              ORDER BY id
            `).all(source.projectId, memoryMaxId) as Array<{ id: number }>;
        for (const row of memories) resolved.add(`agent_memory:${row.id}`);

        if (source.scope === 'project') {
          const investigationMaxId = Number(values.investigation_max_id);
          if (!Number.isSafeInteger(investigationMaxId) || investigationMaxId < 0) return null;
          const investigations = this.db.prepare(`
            SELECT id FROM coder_investigations
            WHERE project_id = ? AND id > ?
            ORDER BY id
          `).all(source.projectId, investigationMaxId) as Array<{ id: number }>;
          for (const row of investigations) resolved.add(`investigation:${row.id}`);
        }
      }
      if (job.cursor?.operation === 'delete') {
        for (const key of [...resolved]) {
          const match = /^agent_memory:(\d+)$/.exec(key);
          if (!match) continue;
          const row = this.db.prepare(`
            SELECT scope, project_id, archived_at FROM agent_memory WHERE id = ?
          `).get(Number(match[1])) as {
            scope: string;
            project_id: number;
            archived_at: string | null;
          } | undefined;
          if (this.memoryRowBelongsToNamespace(row, source)) resolved.delete(key);
        }
      }
    } catch {
      return null;
    }

    const itemKeys = [...resolved];
    return {
      cursor: {
        ...(job.cursor ?? {}),
        item_keys: itemKeys,
        item_keys_truncated: false,
        fence_identity_resolved: true,
        resolved_item_count: itemKeys.length,
      },
      expectedItems: itemKeys.length,
    };
  }

  private applyResolvedMemoryFence(
    job: SemanticJobRow,
    cursor: Record<string, unknown>,
    expectedItems: number,
  ): void {
    const deltaAdjustment = expectedItems - job.expected_items;
    if (deltaAdjustment !== 0 && job.generation_id !== null) {
      this.db.prepare(`
        UPDATE semantic_namespace_generations
        SET delta_items = MAX(0, delta_items + ?), updated_at = datetime('now')
        WHERE namespace = ?
      `).run(deltaAdjustment, job.namespace);
    }
    this.db.prepare(`
      UPDATE semantic_jobs
      SET expected_items = ?, cursor = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(expectedItems, JSON.stringify(cursor), job.id);
  }

  /**
   * Durably record a relational mutation against the vector generation that
   * currently owns the namespace. The job and namespace counter are updated
   * under one IMMEDIATE transaction, so activation can never observe only one
   * side of the mutation.
   *
   * Mutations coalesce only into a job that has not been claimed. Once a
   * builder marks a job `running`, later writes get a new job and therefore a
   * distinct activation watermark.
   */
  noteNamespaceMutation(input: SemanticMutationInput): SemanticJobRow {
    const namespace = input.namespace.trim();
    if (!namespace) throw new Error('Semantic mutation namespace is required');
    const itemKeys = [...new Set(input.itemKeys.map((key) => key.trim()).filter(Boolean))];
    if (itemKeys.length === 0) itemKeys.push('*');
    const deltaCount = itemKeys.length;

    const transact = this.db.transaction((): SemanticJobRow => {
      const state = this.db.prepare(`
        SELECT * FROM semantic_namespace_generations WHERE namespace = ?
      `).get(namespace) as SemanticNamespaceGenerationRow | undefined;
      const generationId = state?.building_generation_id ?? state?.active_generation_id ?? null;

      if (input.fence) {
        const token = input.fence.token.trim();
        const owner = input.fence.owner.trim();
        if (!token || !owner) throw new Error('Semantic mutation fence token and owner are required');
        const startedAt = Date.now();
        const leaseMs = input.fence.leaseMs === undefined
          ? null
          : Math.max(1_000, Math.floor(input.fence.leaseMs));
        const sourceWatermark = itemKeys.includes('*')
          ? this.memorySourceWatermark(namespace)
          : null;
        const cursor = {
          ...this.mergeMutationCursor(null, input, itemKeys, false),
          reason: 'mutation-fence',
          // A fence is one immutable caller, not a coalesced diagnostic row:
          // retain every exact key so settlement can safely narrow it.
          item_keys: itemKeys,
          item_keys_truncated: false,
          fence_phase: 'in-flight',
          fence_token: token,
          fence_owner: owner,
          fence_started_at_ms: startedAt,
          ...(sourceWatermark ? { memory_source_watermark: sourceWatermark } : {}),
          ...(leaseMs === null ? {} : { fence_lease_expires_at_ms: startedAt + leaseMs }),
        };
        const inserted = this.db.prepare(`
          INSERT INTO semantic_jobs
            (generation_id, namespace, kind, status, priority, cursor,
              expected_items, started_at)
          VALUES (?, ?, 'delta', 'running', 60, ?, ?, datetime('now'))
        `).run(generationId, namespace, JSON.stringify(cursor), deltaCount);
        if (generationId !== null) {
          this.db.prepare(`
            UPDATE semantic_namespace_generations
            SET delta_items = delta_items + ?, updated_at = datetime('now')
            WHERE namespace = ?
          `).run(deltaCount, namespace);
        }
        return this.getJob(Number(inserted.lastInsertRowid))!;
      }

      if (generationId === null) {
        const existing = this.db.prepare(`
          SELECT * FROM semantic_jobs
          WHERE namespace = ? AND generation_id IS NULL AND kind = 'backfill'
            AND status IN ('pending', 'paused')
          ORDER BY id DESC LIMIT 1
        `).get(namespace) as JsonJobRow | undefined;
        if (existing) {
          const hydrated = hydrateJob(existing);
          const cursor = this.mergeMutationCursor(hydrated.cursor, input, itemKeys);
          this.db.prepare(`
            UPDATE semantic_jobs
            SET status = 'pending', expected_items = expected_items + ?, cursor = ?,
              failed_items = 0, error = NULL, completed_at = NULL,
              updated_at = datetime('now')
            WHERE id = ?
          `).run(deltaCount, JSON.stringify(cursor), hydrated.id);
          return this.getJob(hydrated.id)!;
        }
        return this.createJob({
          generation_id: null,
          namespace,
          kind: 'backfill',
          priority: 40,
          expected_items: deltaCount,
          cursor: this.mergeMutationCursor(null, input, itemKeys),
        });
      }

      const existing = this.db.prepare(`
        SELECT * FROM semantic_jobs
        WHERE namespace = ? AND generation_id = ? AND kind = 'delta'
          AND status IN ('pending', 'paused')
        ORDER BY id DESC LIMIT 1
      `).get(namespace, generationId) as JsonJobRow | undefined;
      let job: SemanticJobRow;
      if (existing) {
        const hydrated = hydrateJob(existing);
        const cursor = this.mergeMutationCursor(hydrated.cursor, input, itemKeys);
        this.db.prepare(`
          UPDATE semantic_jobs
          SET status = 'pending', expected_items = expected_items + ?, cursor = ?,
            failed_items = 0, error = NULL, completed_at = NULL,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(deltaCount, JSON.stringify(cursor), hydrated.id);
        job = this.getJob(hydrated.id)!;
      } else {
        job = this.createJob({
          generation_id: generationId,
          namespace,
          kind: 'delta',
          priority: 40,
          expected_items: deltaCount,
          cursor: this.mergeMutationCursor(null, input, itemKeys),
        });
      }
      this.db.prepare(`
        UPDATE semantic_namespace_generations
        SET delta_items = delta_items + ?, updated_at = datetime('now')
        WHERE namespace = ?
      `).run(deltaCount, namespace);
      return job;
    });
    return transact.immediate();
  }

  /** Settle one durable relational-mutation fence without acknowledging it.
   * The job becomes ordinary pending delta work and is completed only by
   * `finishNamespaceMutationPass` after exact logical + physical coverage. */
  settleNamespaceMutationFence(input: {
    job_id: number;
    token: string;
    mutation_error?: string | null;
  }): SemanticJobRow | null {
    const transact = this.db.transaction((): SemanticJobRow | null => {
      const job = this.getJob(input.job_id);
      if (!job) return null;
      if (job.kind !== 'delta'
        || job.cursor?.reason !== 'mutation-fence'
        || job.cursor?.fence_token !== input.token) {
        throw new Error(`Semantic mutation fence ${input.job_id} does not match its token`);
      }
      if (job.status === 'completed' || job.status === 'cancelled' || job.status === 'failed') {
        return job;
      }
      const resolved = this.resolveMemoryMutationFence(job);
      const resolvedCursor = resolved?.cursor ?? (job.cursor ?? {});
      if (resolved) this.applyResolvedMemoryFence(job, resolvedCursor, resolved.expectedItems);
      const cursor = {
        ...resolvedCursor,
        fence_phase: 'settled',
        fence_settled_at_ms: Date.now(),
        ...(input.mutation_error ? { mutation_error: input.mutation_error } : {}),
      };
      this.db.prepare(`
        UPDATE semantic_jobs
        SET status = 'pending', cursor = ?, error = NULL, completed_at = NULL,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(JSON.stringify(cursor), job.id);
      return this.getJob(job.id);
    });
    return transact.immediate();
  }

  /** Recover fences owned by a previous process. Bootstrap callers must run
   * this before accepting new mutations and order relational source recovery
   * before pending catch-up execution. Current-process fences stay untouched. */
  recoverNamespaceMutationFences(
    namespacePrefix: string,
    currentOwner: string,
    now = Date.now(),
  ): number {
    const transact = this.db.transaction((): number => {
      const rows = (this.db.prepare(`
        SELECT * FROM semantic_jobs
        WHERE namespace LIKE ? AND kind = 'delta' AND status = 'running'
      `).all(`${namespacePrefix}%`) as JsonJobRow[]).map(hydrateJob);
      let recovered = 0;
      for (const job of rows) {
        if (job.cursor?.reason !== 'mutation-fence'
          || job.cursor?.fence_owner === currentOwner) continue;
        const leaseExpiresAt = Number(job.cursor?.fence_lease_expires_at_ms);
        if (Number.isFinite(leaseExpiresAt) && leaseExpiresAt > now) continue;
        // A crash can happen after the source mutation settles and after a
        // semantic pass claims that settled delta. In that case the durable
        // row is `running` + `settled`, not `running` + `in-flight`. Both are
        // previous-process work once their lease has expired and must return
        // to the pending queue; otherwise every semantic control in the UI is
        // blocked forever by work that no process owns.
        const resolved = this.resolveMemoryMutationFence(job);
        const resolvedCursor = resolved?.cursor ?? (job.cursor ?? {});
        if (resolved) this.applyResolvedMemoryFence(job, resolvedCursor, resolved.expectedItems);
        const cursor = {
          ...resolvedCursor,
          fence_phase: 'settled',
          fence_recovered_at_ms: Date.now(),
          recovery_reason: 'process-restart',
        };
        recovered += this.db.prepare(`
          UPDATE semantic_jobs
          SET status = 'pending', cursor = ?, error = NULL, completed_at = NULL,
            updated_at = datetime('now')
          WHERE id = ? AND status = 'running'
        `).run(JSON.stringify(cursor), job.id).changes;
      }
      return recovered;
    });
    return transact.immediate();
  }

  /**
   * Commit one full documentation/snapshot/memory reconciliation pass.
   * Captured jobs are acknowledged, but any job that arrived after the
   * watermark remains open and keeps the building generation non-serving.
   * Progress, acknowledgements
   * and the optional namespace switch share one IMMEDIATE transaction.
   */
  finishNamespaceMutationPass(input: {
    namespace: string;
    generation_id: number;
    expected_items: number;
    indexed_items: number;
    captured_jobs: readonly CapturedSemanticMutationJob[];
    activate: boolean;
  }): SemanticMutationPassResult {
    const transact = this.db.transaction((): SemanticMutationPassResult => {
      const state = this.db.prepare(`
        SELECT * FROM semantic_namespace_generations WHERE namespace = ?
      `).get(input.namespace) as SemanticNamespaceGenerationRow | undefined;
      if (!state) throw new Error(`Semantic namespace not found: ${input.namespace}`);
      if (input.activate) {
        if (state.building_generation_id !== input.generation_id) {
          throw new Error(`Generation ${input.generation_id} is not building for ${input.namespace}`);
        }
      } else if (state.active_generation_id !== input.generation_id) {
        throw new Error(`Generation ${input.generation_id} is not active for ${input.namespace}`);
      }
      if (input.indexed_items < input.expected_items) {
        throw new Error(
          `vector coverage incomplete: ${input.indexed_items}/${input.expected_items} items`,
        );
      }

      const captured = new Map(input.captured_jobs.map((job) => [job.id, job.expected_items]));
      const openRows = this.db.prepare(`
        SELECT * FROM semantic_jobs
        WHERE namespace = ? AND status IN ('pending', 'running', 'paused')
          AND (kind = 'delta' OR (kind = 'backfill' AND generation_id IS NULL))
        ORDER BY id
      `).all(input.namespace) as JsonJobRow[];
      const open = openRows.map(hydrateJob);
      const acknowledged = open.filter((job) =>
        captured.get(job.id) === job.expected_items
        && !(job.cursor?.reason === 'mutation-fence'
          && job.cursor?.fence_phase === 'in-flight'));
      const acknowledgedIds = new Set(acknowledged.map((job) => job.id));
      const pending = acknowledgedIds.size !== captured.size
        || open.some((job) => !acknowledgedIds.has(job.id));
      const drainedDelta = acknowledged
        .filter((job) => job.kind === 'delta')
        .reduce((sum, job) => sum + job.expected_items, 0);
      const remainingDelta = Math.max(0, state.delta_items - drainedDelta);

      for (const job of acknowledged) {
        this.db.prepare(`
          UPDATE semantic_jobs
          SET status = 'completed', processed_items = expected_items,
            failed_items = 0, error = NULL, completed_at = datetime('now'),
            updated_at = datetime('now')
          WHERE id = ?
        `).run(job.id);
      }

      this.db.prepare(`
        UPDATE semantic_namespace_generations
        SET expected_items = ?, indexed_items = ?, failed_items = 0,
          delta_items = ?, last_error = NULL, updated_at = datetime('now')
        WHERE namespace = ?
      `).run(
        input.expected_items,
        input.indexed_items,
        remainingDelta,
        input.namespace,
      );

      const hasPending = pending || remainingDelta > 0;
      let activated = false;
      if (!hasPending && input.activate) {
        const generation = this.getGeneration(input.generation_id);
        if (!generation || (generation.status !== 'building' && generation.status !== 'ready')) {
          throw new Error(`Generation ${input.generation_id} is not activatable`);
        }
        const switched = this.db.prepare(`
          UPDATE semantic_namespace_generations
          SET active_generation_id = ?, building_generation_id = NULL,
            last_error = NULL, updated_at = datetime('now')
          WHERE namespace = ? AND building_generation_id = ? AND delta_items = 0
        `).run(input.generation_id, input.namespace, input.generation_id);
        if (switched.changes !== 1) {
          throw new Error(`Generation ${input.generation_id} lost the activation race for ${input.namespace}`);
        }
        activated = true;
      }

      return {
        state: this.db.prepare(`
          SELECT * FROM semantic_namespace_generations WHERE namespace = ?
        `).get(input.namespace) as SemanticNamespaceGenerationRow,
        pending: hasPending,
        activated,
        completed_job_ids: [...acknowledgedIds],
      };
    });
    return transact.immediate();
  }

  private mergeMutationCursor(
    cursor: Record<string, unknown> | null,
    input: SemanticMutationInput,
    itemKeys: readonly string[],
    boundKeys = true,
  ): Record<string, unknown> {
    const previousKeys = Array.isArray(cursor?.item_keys)
      ? cursor.item_keys.filter((value): value is string => typeof value === 'string')
      : [];
    // Cursor details are diagnostic only; bound them so a hot namespace does
    // not turn job coalescing into an ever-growing JSON document.
    const allKeys = [...new Set([...previousKeys, ...itemKeys])];
    const truncated = cursor?.item_keys_truncated === true || (boundKeys && allKeys.length > 256);
    const mergedKeys = boundKeys ? allKeys.slice(-256) : allKeys;
    const requiresExplicitReindex = cursor?.requires_explicit_reindex === true
      || input.requiresExplicitReindex === true;
    return {
      ...(cursor ?? {}),
      reason: 'relational-mutation',
      operation: input.operation,
      item_keys: mergedKeys,
      ...(truncated ? { item_keys_truncated: true } : {}),
      mutation_count: Math.max(0, Number(cursor?.mutation_count) || 0) + itemKeys.length,
      ...(requiresExplicitReindex ? { requires_explicit_reindex: true } : {}),
    };
  }

  /** Enqueue (or resume) the durable control job for a purpose reindex. */
  enqueueReindexJob(purpose: SemanticPurpose): SemanticJobRow {
    const namespace = `semantic:reindex:${purpose}`;
    return this.db.transaction(() => {
      const existing = this.db.prepare(`
        SELECT * FROM semantic_jobs
        WHERE namespace = ? AND generation_id IS NULL AND kind = 'build'
          AND status IN ('pending', 'running', 'paused')
        ORDER BY id DESC LIMIT 1
      `).get(namespace) as JsonJobRow | undefined;
      if (existing) {
        if (existing.status === 'paused') {
          this.db.prepare(`
            UPDATE semantic_jobs
            SET status = 'pending', error = NULL, completed_at = NULL,
              cursor = json_remove(COALESCE(cursor, '{}'), '$.lease_owner', '$.lease_expires_at_ms'),
              updated_at = datetime('now')
            WHERE id = ? AND status = 'paused'
          `).run(existing.id);
          return this.getJob(existing.id)!;
        }
        return hydrateJob(existing);
      }
      return this.createJob({
        namespace,
        kind: 'build',
        priority: 100,
        cursor: { purpose, attempt: 0, requested_at_ms: Date.now() },
      });
    })();
  }

  /**
   * Publish the durable tombstone used by out-of-process clients before they
   * ask the server-owned vector worker to remove a project database. The
   * marker is intentionally central: a CLI process must never open/unlink a
   * vectors.db that may still be held by the running server worker.
   *
   * `finalizeProject` means the coordinator should delete the relational
   * project only after the worker drain succeeds. Repeated requests coalesce,
   * including recovery from a crash after physical cleanup but before the
   * catalog row was deleted.
   */
  requestProjectRemoval(input: {
    projectId: number;
    requestedBy?: string;
    finalizeProject?: boolean;
  }): SemanticJobRow {
    const namespace = projectRemovalNamespace(input.projectId);
    const requestedBy = input.requestedBy?.trim() || 'unknown';
    const now = Date.now();
    const transact = this.db.transaction((): SemanticJobRow => {
      const existing = this.db.prepare(`
        SELECT * FROM semantic_jobs
        WHERE namespace = ? AND generation_id IS NULL AND kind = 'cleanup'
          AND status NOT IN ('failed', 'cancelled')
        ORDER BY id DESC LIMIT 1
      `).get(namespace) as JsonJobRow | undefined;
      if (existing) {
        const hydrated = hydrateJob(existing);
        const cursor = {
          ...(hydrated.cursor ?? {}),
          reason: 'project-removal',
          projectId: input.projectId,
          requested_by: requestedBy,
          finalize_project: hydrated.cursor?.finalize_project === true || input.finalizeProject === true,
          requested_at_ms: hydrated.cursor?.requested_at_ms ?? now,
          last_requested_at_ms: now,
        };
        this.db.prepare(`
          UPDATE semantic_jobs
          SET status = CASE WHEN status = 'running' THEN status ELSE 'pending' END,
            priority = MAX(priority, 100), cursor = ?, processed_items = 0,
            failed_items = 0, error = NULL, completed_at = NULL,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(JSON.stringify(cursor), hydrated.id);
        return this.getJob(hydrated.id)!;
      }
      return this.createJob({
        namespace,
        kind: 'cleanup',
        priority: 100,
        expected_items: 1,
        cursor: {
          reason: 'project-removal',
          projectId: input.projectId,
          requested_by: requestedBy,
          finalize_project: input.finalizeProject === true,
          requested_at_ms: now,
          last_requested_at_ms: now,
        },
      });
    });
    return transact.immediate();
  }

  /** A completed marker remains a tombstone until its project row is gone. */
  hasProjectRemovalRequest(projectId: number): boolean {
    return !!this.db.prepare(`
      SELECT 1 FROM semantic_jobs
      WHERE namespace = ? AND generation_id IS NULL AND kind = 'cleanup'
        AND status NOT IN ('failed', 'cancelled')
      LIMIT 1
    `).get(projectRemovalNamespace(projectId));
  }

  /** Persist one generation-less namespace backfill before a vector space can
   * be created. This is the recovery seam for corpus-first ingestion when the
   * embedding provider or semantic worker is temporarily unavailable. */
  enqueueNamespaceBackfill(input: {
    namespace: string;
    cursor?: Record<string, unknown> | null;
    priority?: number;
    error?: string | null;
  }): SemanticJobRow {
    if (!input.namespace.trim()) throw new Error('Semantic backfill namespace is required');
    return this.db.transaction(() => {
      const existing = this.db.prepare(`
        SELECT * FROM semantic_jobs
        WHERE namespace = ? AND generation_id IS NULL AND kind = 'backfill'
          AND status IN ('pending', 'running', 'paused')
        ORDER BY id DESC LIMIT 1
      `).get(input.namespace) as JsonJobRow | undefined;
      if (existing) {
        const hydrated = hydrateJob(existing);
        const cursor = { ...(hydrated.cursor ?? {}), ...(input.cursor ?? {}) };
        this.db.prepare(`
          UPDATE semantic_jobs
          SET status = CASE WHEN status = 'paused' THEN 'pending' ELSE status END,
            priority = MAX(priority, ?), cursor = ?, error = ?, completed_at = NULL,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(
          input.priority ?? hydrated.priority,
          Object.keys(cursor).length > 0 ? JSON.stringify(cursor) : null,
          input.error === undefined ? hydrated.error : input.error,
          hydrated.id,
        );
        return this.getJob(hydrated.id)!;
      }
      const job = this.createJob({
        namespace: input.namespace,
        kind: 'backfill',
        priority: input.priority ?? 50,
        cursor: input.cursor,
      });
      return input.error === undefined
        ? job
        : this.updateJob(job.id, { error: input.error })!;
    })();
  }

  /**
   * Return abandoned reindex leases to the persistent queue. Namespace build
   * jobs are deliberately excluded: their lifecycle belongs to the semantic
   * coordinator, not this control-plane dispatcher.
   */
  recoverExpiredReindexJobs(nowMs = Date.now()): number {
    return this.db.prepare(`
      UPDATE semantic_jobs
      SET status = 'pending', error = 'worker lease expired; queued for recovery',
        cursor = json_remove(COALESCE(cursor, '{}'), '$.lease_owner', '$.lease_expires_at_ms'),
        updated_at = datetime('now')
      WHERE namespace IN ('semantic:reindex:code', 'semantic:reindex:docs', 'semantic:reindex:memory')
        AND generation_id IS NULL
        AND kind = 'build'
        AND status = 'running'
        AND (
          json_extract(cursor, '$.lease_expires_at_ms') IS NULL
          OR json_extract(cursor, '$.lease_expires_at_ms') <= ?
        )
    `).run(nowMs).changes;
  }

  /** Atomically lease the next durable reindex request to one worker. */
  claimNextReindexJob(
    workerId: string,
    leaseMs = 30_000,
    nowMs = Date.now(),
    purpose?: SemanticPurpose,
  ): SemanticJobRow | null {
    return this.db.transaction(() => {
      this.recoverExpiredReindexJobs(nowMs);
      const namespace = purpose ? `semantic:reindex:${purpose}` : null;
      const row = this.db.prepare(`
        SELECT * FROM semantic_jobs
        WHERE namespace IN ('semantic:reindex:code', 'semantic:reindex:docs', 'semantic:reindex:memory')
          AND generation_id IS NULL
          AND kind = 'build'
          AND status = 'pending'
          AND (? IS NULL OR namespace = ?)
        ORDER BY priority DESC, id
        LIMIT 1
      `).get(namespace, namespace) as JsonJobRow | undefined;
      if (!row) return null;
      const cursor = row.cursor ? parseJson<Record<string, unknown>>(row.cursor) : {};
      const nextCursor = {
        ...cursor,
        attempt: Math.max(0, Number(cursor.attempt) || 0) + 1,
        lease_owner: workerId,
        lease_expires_at_ms: nowMs + Math.max(1, leaseMs),
      };
      const claimed = this.db.prepare(`
        UPDATE semantic_jobs
        SET status = 'running', cursor = ?, error = NULL,
          started_at = COALESCE(started_at, datetime('now')),
          completed_at = NULL, updated_at = datetime('now')
        WHERE id = ? AND status = 'pending'
      `).run(JSON.stringify(nextCursor), row.id);
      return claimed.changes === 1 ? this.getJob(row.id) : null;
    })();
  }

  renewReindexJobLease(
    id: number,
    workerId: string,
    leaseMs = 30_000,
    nowMs = Date.now(),
  ): boolean {
    return this.db.transaction(() => {
      const job = this.getJob(id);
      if (
        !job
        || job.status !== 'running'
        || !['semantic:reindex:code', 'semantic:reindex:docs', 'semantic:reindex:memory'].includes(job.namespace)
        || job.cursor?.lease_owner !== workerId
      ) return false;
      const cursor = { ...job.cursor, lease_expires_at_ms: nowMs + Math.max(1, leaseMs) };
      return this.db.prepare(`
        UPDATE semantic_jobs SET cursor = ?, updated_at = datetime('now')
        WHERE id = ? AND status = 'running'
      `).run(JSON.stringify(cursor), id).changes === 1;
    })();
  }

  getJob(id: number): SemanticJobRow | null {
    const row = this.db.prepare(`SELECT * FROM semantic_jobs WHERE id = ?`).get(id) as JsonJobRow | undefined;
    return row ? hydrateJob(row) : null;
  }

  /**
   * `namespaces` restricts to a known set in SQL. Callers that only care about
   * specific namespaces used to pull the WHOLE table and filter in JS — an
   * unbounded `SELECT *` plus a `JSON.parse` per row (see `hydrateJob`) that
   * grows with job history and runs synchronously on the Electron main thread.
   * Chunked because SQLite caps bound parameters.
   */
  listJobs(
    filter: {
      namespace?: string;
      status?: SemanticJobStatus;
      namespaces?: readonly string[];
      statuses?: readonly SemanticJobStatus[];
      kinds?: readonly SemanticJobKind[];
    } = {},
  ): SemanticJobRow[] {
    const base: string[] = [];
    const baseParams: unknown[] = [];
    if (filter.statuses?.length === 0 || filter.kinds?.length === 0) return [];
    if (filter.namespace) { base.push('namespace = ?'); baseParams.push(filter.namespace); }
    if (filter.status) { base.push('status = ?'); baseParams.push(filter.status); }
    if (filter.statuses) {
      const statuses = [...new Set(filter.statuses)];
      base.push(`status IN (${statuses.map(() => '?').join(',')})`);
      baseParams.push(...statuses);
    }
    if (filter.kinds) {
      const kinds = [...new Set(filter.kinds)];
      base.push(`kind IN (${kinds.map(() => '?').join(',')})`);
      baseParams.push(...kinds);
    }
    const order = 'ORDER BY priority DESC, id';
    const run = (where: string[], params: unknown[]): JsonJobRow[] =>
      this.db
        .prepare(`SELECT * FROM semantic_jobs${where.length ? ` WHERE ${where.join(' AND ')}` : ''}\n      ${order}`)
        .all(...params) as JsonJobRow[];

    if (!filter.namespaces) return run(base, baseParams).map(hydrateJob);

    const unique = [...new Set(filter.namespaces)];
    if (unique.length === 0) return [];
    const rows: JsonJobRow[] = [];
    for (let i = 0; i < unique.length; i += 900) {
      const chunk = unique.slice(i, i + 900);
      rows.push(...run(
        [...base, `namespace IN (${chunk.map(() => '?').join(',')})`],
        [...baseParams, ...chunk],
      ));
    }
    // Chunking loses the global ordering the single-query form guarantees.
    return rows
      .sort((a, b) => (b.priority - a.priority) || (a.id - b.id))
      .map(hydrateJob);
  }

  /** True when an open namespace job represents an unbounded/unknown delta.
   * Query runtimes call this before resolving an embedding backend, so stale
   * vectors cannot trigger an ONNX model load. */
  requiresExplicitNamespaceReindex(namespace: string): boolean {
    return this.listJobs({ namespace }).some((job) => {
      if (job.status !== 'pending' && job.status !== 'paused' && job.status !== 'running') {
        return false;
      }
      if (job.cursor?.requires_explicit_reindex === true) return true;
      if (job.cursor?.reason !== 'code-delta') return false;
      const events = Array.isArray(job.cursor.events) ? job.cursor.events : [];
      return events.length === 0 || events.some((event) =>
        !!event && typeof event === 'object' && (event as { path?: unknown }).path === '*');
    });
  }

  updateJob(id: number, patch: {
    status?: SemanticJobStatus;
    cursor?: Record<string, unknown> | null;
    expected_items?: number;
    processed_items?: number;
    failed_items?: number;
    error?: string | null;
  }): SemanticJobRow | null {
    const current = this.getJob(id);
    if (!current) return null;
    const status = patch.status ?? current.status;
    const terminal = status === 'completed' || status === 'failed' || status === 'cancelled';
    this.db.prepare(`
      UPDATE semantic_jobs SET status = ?, cursor = ?, expected_items = ?, processed_items = ?, failed_items = ?,
        error = ?, started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, datetime('now')) ELSE started_at END,
        completed_at = CASE WHEN ? THEN datetime('now') ELSE completed_at END,
        updated_at = datetime('now') WHERE id = ?
    `).run(
      status,
      patch.cursor === undefined ? (current.cursor ? JSON.stringify(current.cursor) : null) : (patch.cursor ? JSON.stringify(patch.cursor) : null),
      patch.expected_items ?? current.expected_items,
      patch.processed_items ?? current.processed_items, patch.failed_items ?? current.failed_items,
      patch.error === undefined ? current.error : patch.error, status, terminal ? 1 : 0, id,
    );
    return this.getJob(id);
  }

  getStatus(filter: { purpose?: SemanticPurpose; namespace?: string } = {}): SemanticStatus {
    const namespaces = this.listNamespaceGenerations(filter);
    const resolvedPurpose = filter.purpose ?? namespaces[0]?.purpose;
    let generations = this.listGenerations(resolvedPurpose ? { purpose: resolvedPurpose } : {});
    if (filter.namespace) {
      const ids = new Set(namespaces.flatMap((row) => [row.active_generation_id, row.building_generation_id]));
      generations = generations.filter((generation) => ids.has(generation.id));
    }
    const profiles = resolvedPurpose
      ? [this.getProfile(resolvedPurpose)].filter((p): p is SemanticProfileRow => p !== null)
      : this.listProfiles();
    const jobRows = this.listJobs(filter.namespace ? { namespace: filter.namespace } : {});
    const jobs: Record<SemanticJobStatus, number> = {
      pending: 0, running: 0, paused: 0, completed: 0, failed: 0, cancelled: 0,
    };
    for (const job of jobRows) jobs[job.status] += 1;
    return {
      profiles,
      generations,
      namespaces,
      jobs,
      totals: namespaces.reduce((sum, row) => ({
        expected_items: sum.expected_items + row.expected_items,
        indexed_items: sum.indexed_items + row.indexed_items,
        failed_items: sum.failed_items + row.failed_items,
        delta_items: sum.delta_items + row.delta_items,
      }), { expected_items: 0, indexed_items: 0, failed_items: 0, delta_items: 0 }),
    };
  }
}
