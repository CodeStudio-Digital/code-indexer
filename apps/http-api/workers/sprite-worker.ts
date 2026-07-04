/**
 * Sprite worker entrypoint — one per process, runs the CPU-bound RGBA
 * processing pipeline (quantize/resize/outline/…) off the main thread
 * (which, in Electron, IS the whole backend). Quantizing a 1024² image
 * takes 100–300ms of pure compute — enough to visibly freeze the UI if
 * run in-process.
 *
 * Deliberately tiny boot: no DB handle, no services — this worker is pure
 * png→rgba→png compute over `@mcp/sprite-studio` processing functions.
 *
 * RPCs: `process.pipeline` {pngBase64, ops, progressToken?}
 *                          → { pngBase64, width, height }
 *       `stop`             → exit (WorkerHost.evict handshake)
 * Events: `worker.ready` after boot (REQUIRED by WorkerHost.start — without
 *         it the host rejects after 30s).
 *         `sprite.progress` {token, opIndex, note} before each op, only when
 *         the request carried a `progressToken` (echoed back so concurrent
 *         pipelines never cross progress streams).
 */
// IMPORTANT: workers import via relative paths only. Node's loader resolves
// these before tsx/tsconfig `paths` get a chance, so an alias like
// `@mcp/sprite-studio` throws "Cannot find package" inside a worker_thread.
// See apps/http-api/sse/workerFileResolution.ts for context.
import { parentPort } from 'node:worker_threads';
import {
  MessageBridge,
  type MessageBridgeOpts,
} from '../../../packages/orchestrator-host/src/index.js';
import { encodeGif } from '../../../packages/sprite-studio/src/export/gif.js';
import { encodePng } from '../../../packages/sprite-studio/src/processing/png.js';
import { decodeImage, stripDataUriPrefix } from '../../../packages/sprite-studio/src/processing/decode-image.js';
import { runPipeline } from '../../../packages/sprite-studio/src/processing/ops.js';
import { sliceGrid } from '../../../packages/sprite-studio/src/processing/slice.js';
import type { SpriteOp } from '../../../packages/sprite-studio/src/processing/types.js';
import { registerPerfStatsHandler } from './perf-stats.js';

const port = parentPort;
if (!port) throw new Error('sprite-worker.ts: not running inside a worker_thread');

const bridge = new MessageBridge({
  port: port as unknown as MessageBridgeOpts['port'],
  onListenerError: (err, context) => {
    console.warn(`[sprite-worker] listener error in ${context}:`, err);
  },
});

// Per-isolate heap stats for the admin perf monitor (best-effort RPC).
registerPerfStatsHandler(bridge);

interface ProcessPipelinePayload {
  pngBase64: string;
  ops: SpriteOp[];
  /** When present, `sprite.progress` events are emitted with this token. */
  progressToken?: string;
}

bridge.handle('process.pipeline', async (payload) => {
  const { pngBase64, ops, progressToken } = payload as ProcessPipelinePayload;
  if (typeof pngBase64 !== 'string' || pngBase64.length === 0) {
    throw new Error('process.pipeline: pngBase64 is required');
  }
  if (!Array.isArray(ops)) {
    throw new Error('process.pipeline: ops must be an array');
  }
  // Format-sniffing decode: backends emit PNG or JPEG (Gemini/Workers AI);
  // anything else fails with an actionable message instead of "bad signature".
  const img = decodeImage(Buffer.from(stripDataUriPrefix(pngBase64), 'base64'));
  const result = runPipeline(img, ops, (opIndex, note) => {
    if (progressToken) {
      bridge.emit('sprite.progress', { token: progressToken, opIndex, note });
    }
  });
  return {
    pngBase64: encodePng(result).toString('base64'),
    width: result.width,
    height: result.height,
  };
});

// Cut one packed grid image (frame-pack generation) into equal cell PNGs.
bridge.handle('image.slice', async (payload) => {
  const { pngBase64, cols, rows } = payload as { pngBase64: string; cols: number; rows: number };
  if (typeof pngBase64 !== 'string' || pngBase64.length === 0) {
    throw new Error('image.slice: pngBase64 is required');
  }
  const img = decodeImage(Buffer.from(stripDataUriPrefix(pngBase64), 'base64'));
  const cells = sliceGrid(img, cols, rows);
  return { cells: cells.map((c) => encodePng(c).toString('base64')) };
});

// Encode animation frames (PNG each) into one animated GIF (F2 preview).
bridge.handle('gif.encode', async (payload) => {
  const { framesPngBase64, durationsMs, repeat } = payload as {
    framesPngBase64: string[];
    durationsMs: number[];
    repeat?: 'loop' | 'once';
  };
  if (!Array.isArray(framesPngBase64) || framesPngBase64.length === 0) {
    throw new Error('gif.encode: framesPngBase64 is required');
  }
  if (!Array.isArray(durationsMs) || durationsMs.length !== framesPngBase64.length) {
    throw new Error('gif.encode: durationsMs must match framesPngBase64 length');
  }
  const frames = framesPngBase64.map((b64) =>
    decodeImage(Buffer.from(stripDataUriPrefix(b64), 'base64')),
  );
  const gif = encodeGif(frames, durationsMs, { repeat });
  return { gifBase64: gif.toString('base64') };
});

bridge.handle('stop', async () => {
  setImmediate(() => process.exit(0));
  return { ok: true };
});

process.on('uncaughtException', (err) => {
  console.error('[sprite-worker] uncaught exception:', err);
  process.exit(1); // WorkerHost restarts with backoff; the pipeline is pure/idempotent
});
process.on('unhandledRejection', (err) => {
  console.error('[sprite-worker] unhandled rejection:', err);
  process.exit(1);
});

bridge.emit('worker.ready', {});
