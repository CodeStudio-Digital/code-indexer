import { createPool, resolveWorkerSpec } from '@mcp/indexer/workers/pool.js';
import type { SessionLocation } from '@mcp/session-storage';
import type { ConversationStats } from '@mcp/session-storage/fs-store/conversation-stats.js';

const spec = resolveWorkerSpec(import.meta.url, './session-stats-worker');
const pool = createPool<SessionLocation, ConversationStats>({
  name: 'session-stats', size: 1, idleTtlMs: 60_000, workerUrl: spec.url, workerData: spec.bootstrapData,
});

export function readSessionStatsInWorker(location: SessionLocation): Promise<ConversationStats> {
  return pool.dispatch(location);
}
