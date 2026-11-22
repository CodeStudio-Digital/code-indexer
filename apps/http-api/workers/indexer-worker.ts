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
// worker_thread.
import { parentPort, workerData } from 'node:worker_threads';
import {
  MessageBridge,
  type MessageBridgeOpts,
} from '../../../packages/orchestrator-host/src/index.js';
import { CodeIndexDB } from '../../../packages/store/src/db.js';
import { runStructuralIndex } from '../../../packages/indexer/src/indexer/structural.js';
import { InteractivePriorityGate } from '../../../packages/indexer/src/indexer/interactive-priority-gate.js';
import {
  indexFilesStructural,
  removeFilesStructural,
} from '../../../packages/indexer/src/indexer/structural-incremental.js';
import { semanticItemKeysForIndexedPaths } from '../../../packages/indexer/src/indexer/indexer/embedding-candidates.js';
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

const db = new CodeIndexDB(dbPath);
const priorityGate = new InteractivePriorityGate();

const bridge = new MessageBridge({
  port: port as unknown as MessageBridgeOpts['port'],
  onListenerError: (err, context) => {
    console.warn(`[indexer-worker] listener error in ${context}:`, err);
  },
});

// Per-isolate heap stats for the admin perf monitor (best-effort RPC).
registerPerfStatsHandler(bridge);

bridge.on('interactivePriority', (payload) => {
  const { projectId, busy } = payload as { projectId: number; busy: boolean };
  priorityGate.setBusy(projectId, busy);
});

bridge.handle('structuralIndex', async (payload) => {
  const { projectId, maxFiles, allowEmptyWipe, forceReparse, verifyPaths, reportChanges } = payload as {
    projectId: number;
    maxFiles?: number;
    allowEmptyWipe?: boolean;
    forceReparse?: boolean;
    verifyPaths?: string[];
    reportChanges?: boolean;
  };
  let lastEmit = 0;
  return runStructuralIndex(db, projectId, {
    ignorePatterns,
    maxFileSizeKB,
    concurrency,
    maxFiles,
    allowEmptyWipe,
    forceReparse,
    verifyPaths,
    waitForInteractivePriority: () => priorityGate.wait(projectId),
    onChanges: reportChanges
      ? async (events, previousItemKeys) => {
          await bridge.request(
            'structural.changes',
            { projectId, events, previousItemKeys },
            { timeoutMs: 30_000 },
          );
        }
      : undefined,
    onProgress: (p) => {
      const now = Date.now();
      if (p.current !== p.total && now - lastEmit < 150) return;
      lastEmit = now;
      bridge.emit('structural.progress', { projectId, ...p });
    },
  });
});

bridge.handle('indexFiles', async (payload) => {
  const { projectId, relPaths, reportChanges } = payload as {
    projectId: number;
    relPaths: string[];
    reportChanges?: boolean;
  };
  if (reportChanges) {
    await bridge.request('structural.changes', {
      projectId,
      events: relPaths.map((path) => ({ path, kind: 'upsert' as const })),
      previousItemKeys: semanticItemKeysForIndexedPaths(db, projectId, relPaths),
    }, { timeoutMs: 30_000 });
  }
  return indexFilesStructural(db, projectId, relPaths, {
    ignorePatterns,
    maxFileSizeKB,
    concurrency,
  });
});

bridge.handle('removeFiles', async (payload) => {
  const { projectId, relPaths, reportChanges } = payload as {
    projectId: number;
    relPaths: string[];
    reportChanges?: boolean;
  };
  if (reportChanges) {
    await bridge.request('structural.changes', {
      projectId,
      events: relPaths.map((path) => ({ path, kind: 'delete' as const })),
      previousItemKeys: semanticItemKeysForIndexedPaths(db, projectId, relPaths),
    }, { timeoutMs: 30_000 });
  }
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
