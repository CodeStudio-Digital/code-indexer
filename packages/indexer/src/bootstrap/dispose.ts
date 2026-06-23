/**
 * Process-level disposal of everything the indexer allocates as module
 * singletons: the dbWriter worker (drains queued writes), the tree-sitter
 * worker pool, and the shared incremental extractor.
 *
 * Call from every entrypoint's shutdown path (http-api gracefulShutdown,
 * Electron will-quit, CLI command finally blocks). Idempotent and
 * non-throwing — shutdown must never be aborted by a failing disposer.
 */
import { closeDbWriter } from '@mcp/indexer/workers/dbWriter/client.js';
import { closeIndexJobPool } from '@mcp/indexer/workers/indexJob/client.js';
import { disposeSharedExtractor } from '@mcp/indexer/indexer/incremental.js';

export async function disposeIndexerProcessResources(): Promise<void> {
  const results = await Promise.allSettled([
    closeDbWriter(),        // drains pending writes before terminating
    closeIndexJobPool(),
    disposeSharedExtractor(),
  ]);
  const names = ['dbWriter', 'indexJobPool', 'sharedExtractor'];
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.warn(`[indexer] dispose ${names[i]} failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
    }
  });
}
