/**
 * Embeddings worker entrypoint — one per process, owns the local ONNX
 * feature-extraction session, keeping its CPU-bound inference off the main
 * thread (which, in Electron, IS the whole backend). Without this, embedding
 * the "stale" files during a semantic index pins the event loop and freezes
 * the UI.
 *
 * Deliberately tiny boot: unlike indexer-worker there's no DB handle — this
 * worker is pure text→vector compute. It reuses `LocalEmbeddingService`
 * verbatim (idle-lease included), so there's no duplicated lifecycle code.
 *
 * RPCs: `embed`       {texts}  → { vectors, tokens }
 *       `embedQuery`  {text}   → { vector, tokens }
 *       `stop`                 → dispose + exit (WorkerHost.evict handshake)
 * Events: `worker.ready` after boot (REQUIRED by WorkerHost.start — without it
 *         the host rejects after 30s).
 */
// IMPORTANT: workers import via relative paths only. Node's loader resolves
// these before tsx/tsconfig `paths` get a chance, so an alias like
// `@mcp/orchestrator-host` throws "Cannot find package" inside a worker_thread.
// See apps/http-api/sse/workerFileResolution.ts for context.
import { parentPort, workerData } from 'node:worker_threads';
import {
  MessageBridge,
  type MessageBridgeOpts,
} from '../../../packages/orchestrator-host/src/index.js';
import { LocalEmbeddingService } from '../../../packages/indexer/src/search/local-embeddings.js';
import { registerPerfStatsHandler } from './perf-stats.js';

interface EmbeddingsWorkerData {
  model?: string;
  cacheDir?: string;
}

const port = parentPort;
if (!port) throw new Error('embeddings-worker.ts: not running inside a worker_thread');

const { model, cacheDir } = workerData as EmbeddingsWorkerData;

// The host (EmbeddingsWorkerClient) is the single idle-eviction authority —
// it tears down the whole worker (freeing native ONNX RSS wholesale) before
// the inner lease's longer default could fire. So we just keep the default
// lease as a backstop and let the host win.
const svc = new LocalEmbeddingService({ model, cacheDir });

const bridge = new MessageBridge({
  port: port as unknown as MessageBridgeOpts['port'],
  onListenerError: (err, context) => {
    console.warn(`[embeddings-worker] listener error in ${context}:`, err);
  },
});

// Per-isolate heap stats for the admin perf monitor (best-effort RPC).
registerPerfStatsHandler(bridge);

bridge.handle('embed', async (payload) => {
  const { texts } = payload as { texts: string[] };
  return svc.embed(texts);
});

bridge.handle('embedQuery', async (payload) => {
  const { text } = payload as { text: string };
  return svc.embedQuery(text);
});

bridge.handle('stop', async () => {
  await svc.dispose().catch(() => undefined);
  setImmediate(() => process.exit(0));
  return { ok: true };
});

process.on('exit', () => {
  void svc.dispose().catch(() => undefined);
});
process.on('uncaughtException', (err) => {
  console.error('[embeddings-worker] uncaught exception:', err);
  process.exit(1); // WorkerHost restarts with backoff; embed is idempotent
});
process.on('unhandledRejection', (err) => {
  console.error('[embeddings-worker] unhandled rejection:', err);
  process.exit(1);
});

bridge.emit('worker.ready', {});
