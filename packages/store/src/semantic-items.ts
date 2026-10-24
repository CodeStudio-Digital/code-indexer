
import type { SemanticItemStatus, SemanticItemRow } from './semantic-store-types.js';

import type { DB } from './semantic-store-types.js';

export class SemanticItems {
  constructor(private readonly db: DB) {}

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
}
