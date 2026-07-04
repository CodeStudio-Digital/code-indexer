/**
 * Main-thread client for the sprite worker — runs the CPU-bound RGBA
 * processing pipeline (quantize/resize/outline/…) over a lazy, idle-evicting
 * WorkerHost so it never pins the main thread (which, in Electron, IS the
 * whole backend).
 *
 * Unlike EmbeddingsWorkerClient there is deliberately NO in-process
 * fallback: running the pipeline on the main thread would freeze the UI —
 * exactly the failure mode this worker exists to prevent. A missing worker
 * build or a permanently crashing worker surfaces as a clear error instead.
 *
 * Progress: each request carries a unique `progressToken`; the worker echoes
 * it in `sprite.progress` events so concurrent pipelines never cross streams.
 */
import { WorkerHost } from '@mcp/orchestrator-host';
import type { SpriteOp } from '@mcp/sprite-studio';
import { registerShutdownTask } from '../server/shutdown-tasks.js';
import { resolveWorkerFile, type ResolvedWorker } from './workerFileResolution.js';

export interface SpritePipelineResult {
  pngBase64: string;
  width: number;
  height: number;
}

export type SpriteProgressListener = (opIndex: number, note: string) => void;

const REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_IDLE_MS = 2 * 60_000;

export class SpriteWorkerClient {
  private host: WorkerHost | null = null;
  private inflight = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private tokenCounter = 0;

  constructor(
    private resolved: ResolvedWorker,
    private idleTtlMs = DEFAULT_IDLE_MS,
  ) {}

  /**
   * Decode → run the serialized op pipeline → encode, inside the worker.
   * `onProgress` fires before each op with its index and a readable note.
   */
  async processPipeline(
    pngBase64: string,
    ops: SpriteOp[],
    onProgress?: SpriteProgressListener,
  ): Promise<SpritePipelineResult> {
    const host = await this.ensureHost();
    const bridge = host.requireBridge();
    const token = `p${++this.tokenCounter}`;
    const off = onProgress
      ? bridge.on('sprite.progress', (payload) => {
          const p = payload as { token?: string; opIndex: number; note: string };
          if (p.token === token) onProgress(p.opIndex, p.note);
        })
      : null;
    this.inflight++;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    try {
      return (await bridge.request(
        'process.pipeline',
        { pngBase64, ops, progressToken: onProgress ? token : undefined },
        { timeoutMs: REQUEST_TIMEOUT_MS },
      )) as SpritePipelineResult;
    } finally {
      off?.();
      this.inflight--;
      this.scheduleIdleEvict();
    }
  }

  /** Cut one packed grid image into cols×rows cell PNGs (frame-pack mode). */
  async sliceGrid(pngBase64: string, cols: number, rows: number): Promise<string[]> {
    const host = await this.ensureHost();
    const bridge = host.requireBridge();
    this.inflight++;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    try {
      const out = (await bridge.request(
        'image.slice',
        { pngBase64, cols, rows },
        { timeoutMs: REQUEST_TIMEOUT_MS },
      )) as { cells: string[] };
      return out.cells;
    } finally {
      this.inflight--;
      this.scheduleIdleEvict();
    }
  }

  /** Encode animation frames (PNG base64 each) into one animated GIF (base64). */
  async encodeGif(
    framesPngBase64: string[],
    durationsMs: number[],
    repeat?: 'loop' | 'once',
  ): Promise<string> {
    const host = await this.ensureHost();
    const bridge = host.requireBridge();
    this.inflight++;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    try {
      const out = (await bridge.request(
        'gif.encode',
        { framesPngBase64, durationsMs, repeat },
        { timeoutMs: REQUEST_TIMEOUT_MS },
      )) as { gifBase64: string };
      return out.gifBase64;
    } finally {
      this.inflight--;
      this.scheduleIdleEvict();
    }
  }

  /**
   * Per-isolate heap stats for the admin perf monitor. Null when the worker
   * isn't spawned — we never spawn just to measure.
   */
  async memStats(
    timeoutMs = 2_000,
  ): Promise<import('../workers/perf-stats.js').WorkerMemStats | null> {
    const host = this.host;
    if (!host || host.state !== 'running') return null;
    try {
      return (await host
        .requireBridge()
        .request('perf.memStats', {}, { timeoutMs })) as import('../workers/perf-stats.js').WorkerMemStats;
    } catch {
      return null;
    }
  }

  async dispose(): Promise<void> {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    const host = this.host;
    this.host = null;
    if (host) await host.evict();
  }

  // ─── Internals ────────────────────────────────────────────────────

  private async ensureHost(): Promise<WorkerHost> {
    // A crashed host (restart budget exhausted) is replaced by a fresh one on
    // the next call — the pipeline is pure/idempotent, so a retry just
    // re-runs. If it keeps dying, each request fails with a clear error.
    if (this.host && this.host.state === 'crashed') this.host = null;
    if (!this.host) {
      this.host = new WorkerHost({
        name: 'sprite',
        workerFile: this.resolved.file,
        execArgv: this.resolved.execArgv,
        workerData: {
          // Dev bootstrap reads this to dynamic-import the TS entry after
          // registering tsx. Absent in production builds.
          tsEntry: this.resolved.devTsEntry,
        },
        maxRestarts: 2,
        defaultRequestTimeoutMs: REQUEST_TIMEOUT_MS,
        onCrash: (err) => console.error(`[sprite-worker] crashed: ${err.message}`),
      });
    }
    await this.host.start();
    return this.host;
  }

  private scheduleIdleEvict(): void {
    if (this.inflight > 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.inflight === 0 && this.host?.isRunning()) {
        void this.host.evict().catch(() => undefined);
      }
    }, this.idleTtlMs);
    this.idleTimer.unref?.();
  }
}

let singleton: SpriteWorkerClient | null = null;
let shutdownHooked = false;

/**
 * Lazy process-wide accessor. Throws when neither the built worker `.js` nor
 * the dev (tsx) bootstrap path resolves — there is NO in-process fallback.
 */
export function getSpriteWorkerClient(): SpriteWorkerClient {
  if (singleton) return singleton;
  const resolved = resolveWorkerFile(import.meta.url, 'sprite-worker');
  if (!resolved) {
    throw new Error(
      'sprite-worker unavailable — image processing requires the worker build ' +
      '(run `pnpm build`, or start the dev server under tsx)',
    );
  }
  const idleEnv = Number(process.env.MCP_SPRITE_WORKER_IDLE_MS);
  singleton = new SpriteWorkerClient(
    resolved,
    Number.isFinite(idleEnv) && idleEnv > 0 ? idleEnv : undefined,
  );
  if (!shutdownHooked) {
    shutdownHooked = true;
    registerShutdownTask('sprite-worker-dispose', () => stopSpriteWorker());
  }
  return singleton;
}

/** Graceful shutdown: evict the worker (if spawned) and drop the singleton. */
export async function stopSpriteWorker(): Promise<void> {
  const client = singleton;
  singleton = null;
  if (client) await client.dispose();
}
