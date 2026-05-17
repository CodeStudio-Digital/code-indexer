import type { CodeIndexDB } from '@mcp/store/db.js';
import type { SnapshotService } from './snapshots.js';

export interface BackfillResult {
  embedded: number;
  failed: number;
  skipped: number;
  errors: string[];
}

/**
 * Embed and upsert any snapshots whose `embedding_hash` is NULL — covers the
 * boot-time auto-backfill, the CLI subcommand, and recovery after a vector
 * backend outage. Always safe to call: snapshots already embedded short-circuit
 * inside `SnapshotService.embedAndUpsert` via the hash check.
 *
 * Processes rows in lots of `batchSize` (default 25) using `Promise.allSettled`
 * so a single bad snapshot does not abort the rest. Returns counts and the
 * first few error messages so callers can decide whether to retry later.
 *
 * Pass a `projectId` to scope; omit to backfill across every project (used at
 * MCP server boot).
 */
export async function backfillSnapshotEmbeddings(
  db: CodeIndexDB,
  snapshotService: SnapshotService,
  projectId?: number,
  batchSize = 25,
): Promise<BackfillResult> {
  const result: BackfillResult = { embedded: 0, failed: 0, skipped: 0, errors: [] };
  if (!snapshotService.hasEmbeddingBackend()) {
    return result;
  }

  const pending = db.listSnapshotsMissingEmbedding(projectId);
  if (pending.length === 0) return result;

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const settled = await Promise.allSettled(
      batch.map((snap) => snapshotService.embedAndUpsert(snap)),
    );
    for (const r of settled) {
      if (r.status === 'rejected') {
        result.failed++;
        if (result.errors.length < 5) result.errors.push(String(r.reason));
        continue;
      }
      const embed = r.value;
      if (embed.ok) {
        if (embed.skipped === 'no-backend' || embed.skipped === 'unchanged') {
          result.skipped++;
        } else {
          result.embedded++;
        }
      } else {
        result.failed++;
        if (embed.error && result.errors.length < 5) result.errors.push(embed.error);
      }
    }
  }
  return result;
}
