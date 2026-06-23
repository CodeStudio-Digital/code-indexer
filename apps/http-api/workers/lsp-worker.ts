/**
 * LSP worker entrypoint — owns the SYNCHRONOUS language compute (TypeScript
 * LanguageService + structural-index fallback queries) so completions,
 * hover, diagnostics and semantic tokens stop blocking the main thread
 * (which, in Electron, is the whole backend: IPC, file tree, terminal).
 *
 * State here:
 *   - document-store MIRROR (same module, this thread's instance) fed by
 *     fire-and-forget doc.* events. The bridge shares one FIFO port for
 *     events and requests, and the doc handlers below are synchronous, so
 *     a doc.change posted before an lsp.call is always applied first.
 *   - TS services per project root (idle-evicted internally, 5min).
 *   - Own WAL DB handle (SELECT-only: index-fallback queries).
 *
 * RPC: `lsp.call` {op, ctx} → executor result, or {__stale:true} when the
 * mirror lags ctx.docVersion (events lost across an evict/respawn — the
 * client resyncs the doc and retries once).
 * Events in: doc.open/doc.change/doc.close. Out: doc.resyncNeeded.
 */
// IMPORTANT: workers import via relative paths only (see indexer-worker.ts).
import { parentPort, workerData } from 'node:worker_threads';
import {
  MessageBridge,
  type MessageBridgeOpts,
} from '../../../packages/orchestrator-host/src/index.js';
import { CodeIndexDB } from '../../../packages/store/src/db.js';
import {
  openDoc,
  changeDoc,
  closeDoc,
  getDoc,
} from '../../../packages/api-handlers/src/lsp/document-store.js';
import { createInProcessLspExecutor } from '../../../packages/api-handlers/src/lsp/executor-inproc.js';
import type {
  DocChangeEvent,
  DocCloseEvent,
  DocOpenEvent,
  LspCallPayload,
} from '../../../packages/api-handlers/src/lsp/executor-types.js';
import { disposeAllTsServices } from '../../../packages/code-agent/src/lsp/ts-service.js';
import { registerPerfStatsHandler } from './perf-stats.js';

interface LspWorkerData {
  dbPath: string;
}

const port = parentPort;
if (!port) throw new Error('lsp-worker.ts: not running inside a worker_thread');

const { dbPath } = workerData as LspWorkerData;
const db = new CodeIndexDB(dbPath);

const bridge = new MessageBridge({
  port: port as unknown as MessageBridgeOpts['port'],
  onListenerError: (err, context) => {
    console.warn(`[lsp-worker] listener error in ${context}:`, err);
  },
});

registerPerfStatsHandler(bridge);

const executor = createInProcessLspExecutor(db);

// ─── Document mirror (synchronous handlers — keep the FIFO guarantee) ─────
bridge.on('doc.open', (data) => {
  const e = data as DocOpenEvent;
  openDoc(e.projectId, e.file, e.languageId, e.version, e.content);
});

bridge.on('doc.change', (data) => {
  const e = data as DocChangeEvent;
  if (!changeDoc(e.projectId, e.file, e.version, e.changes)) {
    // Mirror diverged (missed frame / never opened) — ask main for a full
    // doc.open. Best-effort: the per-request docVersion check still guards
    // any op that races this resync.
    bridge.emit('doc.resyncNeeded', { projectId: e.projectId, file: e.file });
  }
});

bridge.on('doc.close', (data) => {
  const e = data as DocCloseEvent;
  closeDoc(e.projectId, e.file);
});

// ─── Compute RPC ───────────────────────────────────────────────────────────
bridge.handle('lsp.call', async (payload) => {
  const { op, ctx } = payload as LspCallPayload;
  if (ctx.docVersion !== undefined) {
    const mirror = getDoc(ctx.projectId, ctx.file);
    if (!mirror || mirror.version < ctx.docVersion) return { __stale: true };
  }
  return executor[op](ctx);
});

bridge.handle('stop', async () => {
  // Free the TS program graphs before exiting (they dominate the heap).
  try { disposeAllTsServices(); } catch { /* exiting anyway */ }
  setImmediate(() => process.exit(0));
  return { ok: true };
});

process.on('exit', () => {
  try { db.close(); } catch { /* already closed */ }
});
process.on('uncaughtException', (err) => {
  console.error('[lsp-worker] uncaught exception:', err);
  process.exit(1); // WorkerHost restarts with backoff; client replays open docs
});
process.on('unhandledRejection', (err) => {
  console.error('[lsp-worker] unhandled rejection:', err);
  process.exit(1);
});

bridge.emit('worker.ready', {});
