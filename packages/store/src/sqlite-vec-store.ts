/**
 * Embedded vector store backed by sqlite-vec (the `vec0` virtual table).
 *
 * Vector CRUD uses no network and no external process: vectors live in a local
 * SQLite file loaded with the sqlite-vec extension.
 *
 * Filtering rides on vec0 metadata columns (project_name/type/ref_id), which
 * v0.1.9 supports directly in the KNN query:
 *   SELECT vid, distance FROM v WHERE embedding MATCH ? AND k = ? AND ...
 *
 * The table is created lazily on first use with the incoming vector's
 * dimension. Switching embedding models (→ a different dimension) is handled
 * one level up (the re-index flow); here a stale-dimension insert/query throws
 * loudly from vec0, which is the signal a re-index is needed.
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type DatabaseConstructor from 'better-sqlite3';
import type { VectorRecord, VectorMatch } from '@mcp/shared/types.js';
import { applyTuningPragmas } from './db/pragmas.js';
import type { VectorSearchOptions, VectorStore } from './vectors.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;

const DEFAULT_TABLE = 'vectors';
const META_KEYS = ['project_name', 'type', 'ref_id'] as const;

function normalizedVector(values: number[]): Float32Array {
  let squaredNorm = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) throw new Error('Embedding contains a non-finite value');
    squaredNorm += value * value;
  }
  if (squaredNorm <= 0 || !Number.isFinite(squaredNorm)) {
    throw new Error('Embedding must have a finite, non-zero norm');
  }
  const norm = Math.sqrt(squaredNorm);
  return Float32Array.from(values, (value) => value / norm);
}

/** vec0 table identifiers are interpolated into SQL and therefore allow only
 * a deliberately small identifier grammar. */
export function assertSafeVectorTableName(tableName: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(tableName)) {
    throw new Error(`Unsafe sqlite-vec table name: ${tableName}`);
  }
  return tableName;
}

/** One physical sqlite-vec connection, shareable by generation-specific stores. */
export class SqliteVecDatabase {
  readonly db: DB;
  private extLoad: Promise<void> | null = null;
  private legacyDefaultTableReset: Promise<void> | null = null;
  private closed = false;

  constructor(readonly path: string, opts: { manualCheckpoint?: boolean } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    applyTuningPragmas(this.db);
    if (opts.manualCheckpoint) this.db.pragma('wal_autocheckpoint = 0');
  }

  loadExtension(): Promise<void> {
    if (!this.extLoad) {
      this.extLoad = import('sqlite-vec').then((sqliteVec) => {
        (sqliteVec as { load: (db: DB) => void }).load(this.db);
      });
    }
    return this.extLoad;
  }

  /**
   * The pre-generation architecture stored every vector in the default
   * `vectors` table. Generation-aware stores never serve that table and must
   * not carry it forever beside code_g_N/knowledge_g_N. Drop it once per
   * physical connection after sqlite-vec is loaded; the relational sources
   * are the only migration input and will be embedded into fresh tables.
   */
  discardLegacyDefaultTable(): Promise<void> {
    if (!this.legacyDefaultTableReset) {
      this.legacyDefaultTableReset = this.loadExtension().then(() => {
        const exists = this.db
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(DEFAULT_TABLE);
        if (!exists) return;
        this.db.exec(`DROP TABLE ${DEFAULT_TABLE}`);
        // DROP releases pages for reuse but does not shrink the file. This is
        // a one-time migration on a worker-owned handle, so reclaim the old
        // remote/local vector payload immediately when SQLite permits it.
        try { this.db.exec('VACUUM'); } catch (error) {
          console.warn(`[sqlite-vec] legacy table dropped but VACUUM was deferred: ${
            error instanceof Error ? error.message : String(error)
          }`);
        }
        console.warn('[sqlite-vec] discarded pre-generation vectors table; semantic backfill required.');
      });
    }
    return this.legacyDefaultTableReset;
  }

  checkpoint(): void {
    if (this.closed) return;
    try { this.db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
  }

  /** Reclaim free pages after explicit administrative cleanup. This runs only
   * on the semantic worker while its pool has the physical DB drained. */
  compact(): void {
    if (this.closed) throw new Error(`Vector database is closed: ${this.path}`);
    this.checkpoint();
    this.db.exec('VACUUM');
    this.checkpoint();
  }

  close(): void {
    if (this.closed) return;
    this.checkpoint();
    this.db.close();
    this.closed = true;
  }
}

export class SqliteVecVectorStore implements VectorStore {
  private readonly database: SqliteVecDatabase;
  private readonly db: DB;
  private readonly tableName: string;
  private readonly ownsDatabase: boolean;
  private dim: number | null = null;

  constructor(opts: { path: string; tableName?: string } | { database: SqliteVecDatabase; tableName?: string }) {
    this.tableName = assertSafeVectorTableName(opts.tableName ?? DEFAULT_TABLE);
    this.database = 'database' in opts ? opts.database : new SqliteVecDatabase(opts.path);
    this.ownsDatabase = !('database' in opts);
    this.db = this.database.db;
  }

  /** Load the sqlite-vec extension into this connection (once). */
  private async loadExt(): Promise<void> {
    await this.database.loadExtension();
    if (this.tableName !== DEFAULT_TABLE) {
      await this.database.discardLegacyDefaultTable();
    }
  }

  private tableExists(): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?")
      .get(this.tableName);
  }

  /** True when the existing table predates the `namespace` column. */
  private isLegacySchema(): boolean {
    if (this.tableName !== DEFAULT_TABLE) return false;
    const cols = this.db.prepare(`PRAGMA table_info(${this.tableName})`).all() as Array<{ name: string }>;
    return cols.length > 0 && !cols.some((c) => c.name === 'namespace');
  }

  /** Legacy vector spaces are intentionally never copied. Their project-name
   * namespaces and unknown model dimensions cannot satisfy the id/generation
   * invariants, so relational content is re-embedded into a fresh table. */
  private migrateLegacyTable(dim: number): void {
    try {
      this.db.exec(`DROP TABLE IF EXISTS ${this.tableName}`);
      this.db.exec(
        `CREATE VIRTUAL TABLE ${this.tableName} USING vec0(
           vid TEXT PRIMARY KEY, embedding float[${dim}],
           namespace TEXT, project_name TEXT, type TEXT, ref_id TEXT
         )`,
      );
      console.warn('[sqlite-vec] discarded legacy vectors; semantic backfill required.');
    } catch (e) {
      console.warn(`[sqlite-vec] legacy reset failed (${(e as Error).message}); re-index required.`);
      this.db.exec(`DROP TABLE IF EXISTS ${this.tableName}`);
    }
  }

  /** Ensure the vec0 table exists for `dim`, migrating a legacy (no-namespace)
   *  table first. CREATE IF NOT EXISTS is a no-op when up-to-date; a wrong
   *  dimension throws from vec0 on insert/query — the loud "re-index" signal. */
  private async ensureTable(dim: number): Promise<void> {
    await this.loadExt();
    if (this.dim === dim) return;
    if (this.tableExists() && this.isLegacySchema()) this.migrateLegacyTable(dim);
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${this.tableName} USING vec0(
         vid TEXT PRIMARY KEY,
         embedding float[${dim}],
         namespace TEXT,
         project_name TEXT,
         type TEXT,
         ref_id TEXT
       )`,
    );
    this.dim = dim;
  }

  async upsert(records: VectorRecord[], namespace?: string): Promise<number> {
    if (records.length === 0) return 0;
    await this.ensureTable(records[0].values.length);
    const del = this.db.prepare(`DELETE FROM ${this.tableName} WHERE vid = ?`);
    const ins = this.db.prepare(
      `INSERT INTO ${this.tableName}(vid, embedding, namespace, project_name, type, ref_id) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    // vec0 has no UPSERT; delete-then-insert keeps re-embedding idempotent.
    const tx = this.db.transaction((rows: VectorRecord[]) => {
      for (const r of rows) {
        del.run(r.id);
        ins.run(
          r.id,
          normalizedVector(r.values),
          // vec0 0.1.9+ REJECTS NULL in TEXT metadata columns ("Expected text
          // for TEXT metadata column, received NULL"). Bind '' for any absent
          // field; the read-back below treats '' as absent so the metadata
          // shape consumers see is unchanged (code vectors always set all three).
          namespace ?? '',
          r.metadata.project_name ?? '',
          r.metadata.type ?? '',
          r.metadata.ref_id ?? '',
        );
      }
    });
    tx(records);
    return records.length;
  }

  async search(
    queryVector: number[],
    options?: VectorSearchOptions,
  ): Promise<VectorMatch[]> {
    await this.loadExt();
    if (!this.tableExists() || this.isLegacySchema()) return [];
    const topK = options?.topK ?? 20;
    const filter = options?.filter ?? {};

    const where: string[] = ['embedding MATCH ?', 'k = ?'];
    const params: unknown[] = [normalizedVector(queryVector), topK];
    if (options?.namespace) {
      where.push('namespace = ?');
      params.push(options.namespace);
    }
    for (const key of META_KEYS) {
      if (filter[key] !== undefined) {
        where.push(`${key} = ?`);
        params.push(filter[key]);
      }
    }

    const rows = this.db
      .prepare(
        `SELECT vid, distance, project_name, type, ref_id
         FROM ${this.tableName} WHERE ${where.join(' AND ')} ORDER BY distance`,
      )
      .all(...params) as Array<{
        vid: string;
        distance: number;
        project_name: string | null;
        type: string | null;
        ref_id: string | null;
      }>;

    return rows.map((r) => {
      const metadata: Record<string, string> = {};
      // Truthy check (not `!== null`): incomplete-metadata rows now store '' (see
      // upsert) — omit them so the shape matches the pre-0.1.9 NULL-omit behavior.
      if (r.project_name) metadata.project_name = r.project_name;
      if (r.type) metadata.type = r.type;
      if (r.ref_id) metadata.ref_id = r.ref_id;
      // vec0 returns L2 distance (lower = better); map to higher-is-better so
      // downstream sort/RRF ranking matches the other stores.
      return { id: r.vid, score: 1 / (1 + r.distance), metadata };
    });
  }

  async deleteByIds(ids: string[], _namespace?: string): Promise<number> {
    if (ids.length === 0) return 0;
    await this.loadExt();
    if (!this.tableExists()) return 0;
    const del = this.db.prepare(`DELETE FROM ${this.tableName} WHERE vid = ?`);
    const tx = this.db.transaction((list: string[]) => {
      for (const id of list) del.run(id);
    });
    tx(ids);
    return ids.length;
  }

  /** Drop every vector in a namespace — O(rows-in-namespace), no re-embed. */
  async deleteNamespace(namespace: string): Promise<number> {
    await this.loadExt();
    if (!this.tableExists() || this.isLegacySchema()) return 0;
    const info = this.db.prepare(`DELETE FROM ${this.tableName} WHERE namespace = ?`).run(namespace);
    return info.changes;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.loadExt();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Every vector id in the store (optionally one namespace). Class-only test
   * and diagnostic helper; normal reconciliation uses `semantic_items`.
   */
  async listIds(namespace?: string): Promise<string[]> {
    await this.loadExt();
    if (!this.tableExists()) return [];
    const rows = namespace !== undefined && !this.isLegacySchema()
      ? this.db.prepare(`SELECT vid FROM ${this.tableName} WHERE namespace = ?`).all(namespace) as Array<{ vid: string }>
      : this.db.prepare(`SELECT vid FROM ${this.tableName}`).all() as Array<{ vid: string }>;
    return rows.map((r) => r.vid);
  }

  /** Drop this generation table. The identifier was validated at construction. */
  async dropTable(): Promise<void> {
    await this.loadExt();
    this.db.exec(`DROP TABLE IF EXISTS ${this.tableName}`);
    this.dim = null;
  }

  async hasTable(): Promise<boolean> {
    await this.loadExt();
    return this.tableExists();
  }

  checkpoint(): void { this.database.checkpoint(); }

  /** Close the underlying connection (per-project stores are pooled + evicted). */
  close(): void {
    if (this.ownsDatabase) this.database.close();
  }
}
