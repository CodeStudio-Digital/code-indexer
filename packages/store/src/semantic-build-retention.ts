import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { DB } from './semantic-store-types.js';

// These jobs describe attempts. Deltas, mutation fences, leases and explicit
// reindex requests have independent identities and must never be collapsed.
const pausedAttempts = `status = 'paused' AND kind IN ('build','backfill') AND generation_id IS NOT NULL
  AND (namespace = 'memory:user' OR namespace GLOB 'memory:project:p[0-9]*'
    OR namespace GLOB 'snapshot:p[0-9]*' OR namespace GLOB 'docs:c[0-9]*')
  AND json_extract(cursor, '$.reason') IS NOT 'mutation-fence'
  AND json_extract(cursor, '$.lease_owner') IS NULL`;
const fields = ['namespace', 'generation_id', 'kind', 'priority', 'cursor', 'expected_items',
  'processed_items', 'failed_items', 'error'] as const;

/** Run on the maintenance worker. Two rows must still match inside the delete
 * transaction; a concurrent retry can change either one between read batches. */
export async function pruneDuplicateSemanticBuilds(db: DB, signal?: AbortSignal): Promise<number> {
  // Page through the rowid once. The status/priority queue index otherwise
  // sorts the remaining backlog again for every batch.
  const read = db.prepare(`SELECT id, ${fields.join(', ')} FROM semantic_jobs NOT INDEXED
    WHERE id < ? AND ${pausedAttempts} ORDER BY id DESC LIMIT 128`);
  const remove = db.prepare(`DELETE FROM semantic_jobs AS j WHERE id = ? AND ${pausedAttempts}
    AND EXISTS (SELECT 1 FROM semantic_jobs k WHERE k.id = ? AND k.status = 'paused'
      AND ${fields.map(field => `k.${field} IS j.${field}`).join(' AND ')})`);
  const removeBatch = db.transaction((pairs: Array<[number, number]>) =>
    pairs.reduce((n, pair) => n + remove.run(...pair).changes, 0));
  db.exec('CREATE TEMP TABLE semantic_build_keepers (signature BLOB PRIMARY KEY, id INTEGER NOT NULL) WITHOUT ROWID');
  try {
    const getKeeper = db.prepare('SELECT id FROM temp.semantic_build_keepers WHERE signature = ?').pluck();
    const remember = db.prepare('INSERT INTO temp.semantic_build_keepers(signature, id) VALUES (?, ?)');
    let before = Number.MAX_SAFE_INTEGER;
    let deleted = 0;
    while (!signal?.aborted) {
      const rows = read.all(before) as Array<{ id: number } & Record<typeof fields[number], string | number | null>>;
      if (!rows.length) break;
      const duplicates: Array<[number, number]> = [];
      for (const row of rows) {
        const signature = createHash('sha256').update(JSON.stringify(fields.map(field => row[field]))).digest();
        const newest = getKeeper.get(signature) as number | undefined;
        if (newest !== undefined) duplicates.push([row.id, newest]);
        else remember.run(signature, row.id);
      }
      if (duplicates.length) deleted += removeBatch.immediate(duplicates);
      before = rows[rows.length - 1]!.id;
      if (rows.length < 128) break;
      await delay(25);
    }
    return deleted;
  } finally { db.exec('DROP TABLE temp.semantic_build_keepers'); }
}
