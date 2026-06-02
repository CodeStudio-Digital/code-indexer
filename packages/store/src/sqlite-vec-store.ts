/**
 * Embedded vector store backed by sqlite-vec (the `vec0` virtual table).
 *
 * Unlike the Cloudflare / Qdrant / Pinecone / OpenSearch adapters this needs
 * NO network and NO external process — vectors live in a local SQLite file
 * loaded with the sqlite-vec extension. That makes RAG work fully offline,
 * which is the point for a desktop IDE (and removes the per-query Cloudflare
 * round-trip + cost).
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
import type DatabaseConstructor from 'better-sqlite3';
import type { VectorRecord, VectorMatch } from '@mcp/shared/types.js';
import { codeNamespace } from '@mcp/shared/vector-namespace.js';
import type { VectorStore } from './vectors.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;

const TABLE = 'vectors';
const META_KEYS = ['project_name', 'type', 'ref_id'] as const;

/**
 * Default on-disk location for the vectors DB when the admin config doesn't
 * pin a `path`. Co-locates beside the main index DB (MCP_INDEX_DB) so a
 * project's data and its vectors live together; falls back to the user's
 * ~/.mcp-code-indexer dir.
 */
export function defaultSqliteVecPath(): string {
  const indexDb = process.env.MCP_INDEX_DB;
  if (indexDb) {
    const slash = Math.max(indexDb.lastIndexOf('/'), indexDb.lastIndexOf('\\'));
    const dir = slash >= 0 ? indexDb.slice(0, slash) : '.';
    return `${dir}/vectors-sqlite-vec.db`;
  }
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '.';
  return `${home}/.mcp-code-indexer/vectors-sqlite-vec.db`;
}

export class SqliteVecVectorStore implements VectorStore {
  private db: DB;
  private extLoaded = false;
  private dim: number | null = null;

  constructor(opts: { path: string }) {
    this.db = new Database(opts.path);
    this.db.pragma('journal_mode = WAL');
  }

  /** Load the sqlite-vec extension into this connection (once). */
  private async loadExt(): Promise<void> {
    if (this.extLoaded) return;
    const sqliteVec = (await import('sqlite-vec')) as { load: (db: DB) => void };
    sqliteVec.load(this.db);
    this.extLoaded = true;
  }

  private tableExists(): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?")
      .get(TABLE);
  }

  /** True when the existing table predates the `namespace` column. */
  private isLegacySchema(): boolean {
    const cols = this.db.prepare(`PRAGMA table_info(${TABLE})`).all() as Array<{ name: string }>;
    return cols.length > 0 && !cols.some((c) => c.name === 'namespace');
  }

  /**
   * One-time migration of a pre-namespace table. We preserve CODE vectors by
   * copying their raw embedding into the new schema and deriving the namespace
   * from `project_name` (the only tenant key those rows ever stored). DOC rows
   * (`doc_chunk:*`) carry no resolvable collection here — they're dropped and
   * re-ingestion re-embeds them. Best-effort: any failure falls back to drop +
   * re-index (the relational hashes still drive incremental re-embed).
   */
  private migrateLegacyTable(dim: number): void {
    const legacy = `${TABLE}_legacy_ns`;
    try {
      this.db.exec(`ALTER TABLE ${TABLE} RENAME TO ${legacy}`);
      this.db.exec(
        `CREATE VIRTUAL TABLE ${TABLE} USING vec0(
           vid TEXT PRIMARY KEY, embedding float[${dim}],
           namespace TEXT, project_name TEXT, type TEXT, ref_id TEXT
         )`,
      );
      const ins = this.db.prepare(
        `INSERT INTO ${TABLE}(vid, embedding, namespace, project_name, type, ref_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const rows = this.db
        .prepare(`SELECT vid, embedding, project_name, type, ref_id FROM ${legacy}`)
        .all() as Array<{ vid: string; embedding: unknown; project_name: string | null; type: string | null; ref_id: string | null }>;
      const tx = this.db.transaction(() => {
        for (const r of rows) {
          if (r.vid.startsWith('doc_chunk:')) continue; // can't resolve collection → re-ingest
          if (!r.project_name) continue;
          ins.run(r.vid, r.embedding as Buffer, codeNamespace(r.project_name), r.project_name, r.type, r.ref_id);
        }
      });
      tx();
      this.db.exec(`DROP TABLE ${legacy}`);
      console.warn('[sqlite-vec] migrated to namespaced schema; doc vectors need re-ingestion.');
    } catch (e) {
      console.warn(`[sqlite-vec] namespace migration failed (${(e as Error).message}); dropping legacy table — re-index required.`);
      this.db.exec(`DROP TABLE IF EXISTS ${legacy}`);
      this.db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
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
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${TABLE} USING vec0(
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
    const del = this.db.prepare(`DELETE FROM ${TABLE} WHERE vid = ?`);
    const ins = this.db.prepare(
      `INSERT INTO ${TABLE}(vid, embedding, namespace, project_name, type, ref_id) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    // vec0 has no UPSERT; delete-then-insert keeps re-embedding idempotent.
    const tx = this.db.transaction((rows: VectorRecord[]) => {
      for (const r of rows) {
        del.run(r.id);
        ins.run(
          r.id,
          new Float32Array(r.values),
          namespace ?? null,
          r.metadata.project_name ?? null,
          r.metadata.type ?? null,
          r.metadata.ref_id ?? null,
        );
      }
    });
    tx(records);
    return records.length;
  }

  async search(
    queryVector: number[],
    options?: { topK?: number; filter?: Record<string, string>; namespace?: string },
  ): Promise<VectorMatch[]> {
    await this.loadExt();
    if (!this.tableExists() || this.isLegacySchema()) return [];
    const topK = options?.topK ?? 20;
    const filter = options?.filter ?? {};

    const where: string[] = ['embedding MATCH ?', 'k = ?'];
    const params: unknown[] = [new Float32Array(queryVector), topK];
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
         FROM ${TABLE} WHERE ${where.join(' AND ')} ORDER BY distance`,
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
      if (r.project_name !== null) metadata.project_name = r.project_name;
      if (r.type !== null) metadata.type = r.type;
      if (r.ref_id !== null) metadata.ref_id = r.ref_id;
      // vec0 returns L2 distance (lower = better); map to higher-is-better so
      // downstream sort/RRF ranking matches the other stores.
      return { id: r.vid, score: 1 / (1 + r.distance), metadata };
    });
  }

  async deleteByIds(ids: string[], _namespace?: string): Promise<number> {
    if (ids.length === 0) return 0;
    await this.loadExt();
    if (!this.tableExists()) return 0;
    const del = this.db.prepare(`DELETE FROM ${TABLE} WHERE vid = ?`);
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
    const info = this.db.prepare(`DELETE FROM ${TABLE} WHERE namespace = ?`).run(namespace);
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
}
