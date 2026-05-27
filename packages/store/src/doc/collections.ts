import type { Database as DB } from 'better-sqlite3';
import type {
  DocCollection,
  DocCollectionInput,
  DocCollectionStatus,
} from './types.js';
import { mapCollection } from './mappers.js';

export function create(db: DB, input: DocCollectionInput): DocCollection {
  const stmt = db.prepare(`
    INSERT INTO doc_collections (name, description, embedding_provider_id)
    VALUES (?, ?, ?)
  `);
  const result = stmt.run(
    input.name,
    input.description ?? null,
    input.embedding_provider_id ?? null,
  );
  return get(db, result.lastInsertRowid as number)!;
}

export function get(db: DB, id: number): DocCollection | null {
  const row = db.prepare('SELECT * FROM doc_collections WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapCollection(row) : null;
}

export function getByName(db: DB, name: string): DocCollection | null {
  const row = db.prepare('SELECT * FROM doc_collections WHERE name = ?').get(name) as
    | Record<string, unknown>
    | undefined;
  return row ? mapCollection(row) : null;
}

export function list(db: DB): DocCollection[] {
  const rows = db.prepare('SELECT * FROM doc_collections ORDER BY name').all() as Array<
    Record<string, unknown>
  >;
  return rows.map(mapCollection);
}

export function updateStatus(
  db: DB,
  id: number,
  status: DocCollectionStatus,
  message?: string | null,
): void {
  db
    .prepare(
      `UPDATE doc_collections
          SET status = ?, status_message = ?, updated_at = datetime('now')
        WHERE id = ?`,
    )
    .run(status, message ?? null, id);
}

export function refreshCounts(db: DB, id: number): void {
  db
    .prepare(
      `UPDATE doc_collections
          SET chunk_count  = (SELECT COUNT(*) FROM doc_chunks  WHERE collection_id = ?),
              source_count = (SELECT COUNT(*) FROM doc_sources WHERE collection_id = ?),
              updated_at   = datetime('now')
        WHERE id = ?`,
    )
    .run(id, id, id);
}

export function del(db: DB, id: number): void {
  db.prepare('DELETE FROM doc_collections WHERE id = ?').run(id);
}
