/**
 * Process-level disposal of everything the indexer allocates as module
 * singletons: the tree-sitter worker pool and the shared incremental
 * extractor. Session persistence owns independent filesystem writers.
 *
 * Call from every entrypoint's shutdown path (http-api gracefulShutdown,
 * Electron will-quit, CLI command finally blocks). Idempotent and
 * non-throwing — shutdown must never be aborted by a failing disposer.
 */
import { closeIndexJobPool } from '@mcp/indexer/workers/indexJob/client.js';
import { disposeSharedExtractor } from '@mcp/indexer/indexer/incremental.js';

export async function disposeIndexerProcessResources(): Promise<void> {
  const results = await Promise.allSettled([
    closeIndexJobPool(),
    disposeSharedExtractor(),
  ]);
  const names = ['indexJobPool', 'sharedExtractor'];
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.warn(`[indexer] dispose ${names[i]} failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
    }
  });
}
