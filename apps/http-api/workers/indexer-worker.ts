/**
 * Indexer worker entrypoint — one per process, owns the STRUCTURAL pipeline
 * (scanner + tree-sitter + SQLite writes), keeping its CPU-bound loops off
 * the main thread (which, in Electron, IS the whole backend).
 *
 * Deliberately tiny boot: the structural pipeline needs no provider, no
 * embedding service, no vector store — so unlike coder-worker there are no
 * singleton shims to hydrate. Just a WAL DB handle + three RPCs.
 *
 * RPCs: `structuralIndex` {projectId, maxFiles} → StructuralIndexResult
 *       `indexFiles`      {projectId, relPaths} → IndexFilesStructuralResult
 *       `removeFiles`     {projectId, relPaths} → {removed}
 *       `stop`            → flush + exit (WorkerHost.evict handshake)
 * Events: `structural.progress` {projectId, current, total, currentFile}
 *         coalesced to ~150ms; `worker.ready` after boot (REQUIRED by
 *         WorkerHost.start — without it the host rejects after 30s).
 */
// IMPORTANT: workers import via relative paths only. Node's loader
// resolves these before tsx/tsconfig `paths` get a chance, so an alias
// like `@mcp/orchestrator-host` throws "Cannot find package" inside a
// worker_thread. See apps/http-api/sse/workerKit.ts for context.
import { parentPort, workerData } from 'node:worker_threads';
import {
  MessageBridge,
  type MessageBridgeOpts,
} from '../../../packages/orchestrator-host/src/index.js';
import { CodeIndexDB } from '../../../packages/store/src/db.js';
import { runStructuralIndex } from '../../../packages/indexer/src/indexer/structural.js';
import {
  indexFilesStructural,
  removeFilesStructural,
} from '../../../packages/indexer/src/indexer/structural-incremental.js';
import { registerPerfStatsHandler } from './perf-stats.js';

interface IndexerWorkerData {
  dbPath: string;
  ignorePatterns?: string[];
  maxFileSizeKB?: number;
  concurrency?: number;
}

const port = parentPort;
if (!port) throw new Error('indexer-worker.ts: not running inside a worker_thread');

const { dbPath, ignorePatterns, maxFileSizeKB, concurrency } = workerData as IndexerWorkerData;

// We ARE the offload thread — a nested tree-sitter worker pool inside this
// worker would only multiply threads for zero main-thread benefit. The
// dispatch reads this at call time and parses in-process here.
process.env.MCP_INDEX_WORKERS = '0';

const db = new CodeIndexDB(dbPath);

const bridge = new MessageBridge({
  port: port as unknown as MessageBridgeOpts['port'],
  onListenerError: (err, context) => {
    console.warn(`[indexer-worker] listener error in ${context}:`, err);
  },
});

// Per-isolate heap stats for the admin perf monitor (best-effort RPC).
registerPerfStatsHandler(bridge);

bridge.handle('structuralIndex', async (payload) => {
  const { projectId, maxFiles, allowEmptyWipe } = payload as {
    projectId: number; maxFiles?: number; allowEmptyWipe?: boolean;
  };
  let lastEmit = 0;
  return runStructuralIndex(db, projectId, {
    ignorePatterns,
    maxFileSizeKB,
    concurrency,
    maxFiles,
    allowEmptyWipe,
    onProgress: (p) => {
      const now = Date.now();
      if (p.current !== p.total && now - lastEmit < 150) return;
      lastEmit = now;
      bridge.emit('structural.progress', { projectId, ...p });
    },
  });
});

bridge.handle('indexFiles', async (payload) => {
  const { projectId, relPaths } = payload as { projectId: number; relPaths: string[] };
  return indexFilesStructural(db, projectId, relPaths, { ignorePatterns, maxFileSizeKB });
});

bridge.handle('removeFiles', async (payload) => {
  const { projectId, relPaths } = payload as { projectId: number; relPaths: string[] };
  return removeFilesStructural(db, projectId, relPaths);
});

bridge.handle('stop', async () => {
  setImmediate(() => process.exit(0));
  return { ok: true };
});

process.on('exit', () => {
  try { db.close(); } catch { /* already closed */ }
});
process.on('uncaughtException', (err) => {
  console.error('[indexer-worker] uncaught exception:', err);
  process.exit(1); // WorkerHost restarts with backoff; runs are hash-idempotent
});
process.on('unhandledRejection', (err) => {
  console.error('[indexer-worker] unhandled rejection:', err);
  process.exit(1);
});

bridge.emit('worker.ready', {});
