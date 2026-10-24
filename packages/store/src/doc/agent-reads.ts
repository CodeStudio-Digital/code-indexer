import type { Database } from 'better-sqlite3';
import { mapChunk } from './mappers.js';
import type { DocChunk } from './types.js';

export interface DocAgentChunk extends DocChunk { content_length: number; char_offset: number; next_char_offset?: number }
export interface DocAgentPage<T> { items: T[]; offset: number; next_offset?: number }
export interface DocAgentOutlineRow { id: number; ord: number; heading_path: string | null; source_uri: string | null; token_count: number }
export interface DocAgentSource { source_id: number; type: string; doc_type: string | null; title: string | null; uri: string; chunk_count: number }
const integer = (value: number | undefined, fallback: number, max: number) =>
  Number.isSafeInteger(value) && value! >= 0 ? Math.min(value!, max) : fallback;
const columns = `id, collection_id, source_id, ord, heading_path, content_hash, token_count,
  source_uri, doc_type, anchor, api_symbol, api_signature, created_at,
  substr(summary,1,2048) AS summary, substr(concepts,1,8192) AS concepts,
  substr(content,?,?) AS content, length(content) AS content_length`;

/** Agent navigation reads only bounded pages and columns. The original
 * ingestion/export APIs retain their complete materialization semantics. */
export class DocAgentReads {
  constructor(private readonly db: Database) {}
  chunk(id: number, charOffset = 0, maxChars = 65536): DocAgentChunk | null {
    const offset = integer(charOffset, 0, Number.MAX_SAFE_INTEGER), limit = Math.max(1, integer(maxChars, 65536, 200000));
    const row = this.db.prepare(`SELECT ${columns} FROM doc_chunks WHERE id=?`).get(offset + 1, limit, id) as Record<string, unknown> | undefined;
    return row ? this.map(row, offset, limit) : null;
  }
  neighbors(seed: DocAgentChunk, window: number): DocAgentChunk[] {
    const distance = integer(window, 1, 3);
    const rows = this.db.prepare(`SELECT ${columns} FROM doc_chunks
      WHERE source_id=? AND source_uri IS ? AND ord BETWEEN ? AND ? AND id<>?
      ORDER BY ord,id LIMIT 6`).all(1, 1201, seed.source_id, seed.source_uri, seed.ord - distance, seed.ord + distance, seed.id) as Record<string, unknown>[];
    return rows.map(row => this.map(row, 0, 1201));
  }
  section(seed: DocAgentChunk, offset = 0, limit = 32): DocAgentPage<DocAgentChunk> {
    return this.page(limit, offset, 64, (take, skip) => (this.db.prepare(`SELECT ${columns} FROM doc_chunks
      WHERE source_id=? AND heading_path IS ? AND source_uri IS ? ORDER BY ord,id LIMIT ? OFFSET ?`)
      .all(1, 65536, seed.source_id, seed.heading_path, seed.source_uri, take, skip) as Record<string, unknown>[])
      .map(row => this.map(row, 0, 65536)));
  }
  outline(sourceId: number, offset = 0, limit = 500): DocAgentPage<DocAgentOutlineRow> {
    return this.page(limit, offset, 500, (take, skip) => this.db.prepare(`SELECT id, ord, heading_path, source_uri, token_count
      FROM doc_chunks WHERE source_id=? ORDER BY ord,id LIMIT ? OFFSET ?`).all(sourceId, take, skip) as DocAgentOutlineRow[]);
  }
  sources(collectionId: number, offset = 0, limit = 100): DocAgentPage<DocAgentSource> {
    return this.page(limit, offset, 500, (take, skip) => this.db.prepare(`SELECT id AS source_id, type, doc_type, title, uri, chunk_count
      FROM doc_sources WHERE collection_id=? ORDER BY id LIMIT ? OFFSET ?`).all(collectionId, take, skip) as DocAgentSource[]);
  }
  private map(row: Record<string, unknown>, offset: number, limit: number): DocAgentChunk {
    const length = Number(row.content_length);
    return { ...mapChunk(row), content_length: length, char_offset: offset,
      ...(offset + limit < length ? { next_char_offset: offset + limit } : {}) };
  }
  private page<T>(requested: number, skip: number, max: number, query: (limit: number, offset: number) => T[]): DocAgentPage<T> {
    const limit = Math.max(1, integer(requested, max, max)), offset = integer(skip, 0, Number.MAX_SAFE_INTEGER);
    const rows = query(limit + 1, offset);
    return { items: rows.slice(0, limit), offset, ...(rows.length > limit ? { next_offset: offset + limit } : {}) };
  }
}
