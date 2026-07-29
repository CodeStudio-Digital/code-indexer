/**
 * WorkerHost — supervisor for one named worker_thread instance.
 *
 * One host per worker. The host owns the `Worker`, the `MessageBridge`
 * to talk to it, and the lifecycle policy:
 *
 *   - `start()` — spawn the worker, wait for the boot handshake
 *   - `request(...)` / `on(...)` / `emit(...)` — delegate to bridge
 *   - `evict()` — best-effort graceful shutdown (`stop` request + wait)
 *   - on unexpected exit — auto-restart with exponential backoff up to
 *     `maxRestarts`, then mark `crashed` and bubble up via `onCrash`
 *
 * Pool / per-session orchestration is the CALLER's responsibility —
 * `WorkerHost` knows nothing about sessions. A `WorkerPool` layered on
 * top maps `sessionId → WorkerHost` with TTL eviction.
 */
import { Worker } from 'node:worker_threads';
import type { Worker as WorkerType, WorkerOptions } from 'node:worker_threads';
import { MessageBridge, type MessageBridgeOpts } from './MessageBridge.js';

export interface WorkerHostOpts<TWorkerData = unknown> {
  /** Path to the worker entry file. Must be a built `.js`. */
  workerFile: string;
  /** Optional `workerData` passed to the worker constructor. */
  workerData?: TWorkerData;
  /**
   * Extra `execArgv` forwarded to `new Worker(file, { execArgv })`.
   * Used to inject `--import tsx/esm` when the worker file is a `.ts`
   * source running under the dev loader.
   */
  execArgv?: string[];
  /** Per-isolate V8 limits forwarded to `new Worker(..., { resourceLimits })`. */
  resourceLimits?: WorkerOptions['resourceLimits'];
  /** Optional name used in logs / restart messages. */
  name?: string;
  /** Max restart attempts before marking `crashed`. Default 3. */
  maxRestarts?: number;
  /** Restart backoff base in ms. Default 500. Capped at 8000. */
  restartBackoffMs?: number;
  /** Default request timeout in ms for the bridge. Default 30s. */
  defaultRequestTimeoutMs?: number;
  /** Fired when the worker exits unexpectedly and restart budget is exhausted. */
  onCrash?: (err: Error) => void;
  /** Fired on EVERY exit (planned or not). */
  onExit?: (code: number, planned: boolean) => void;
  /** Optional fatal-error logger. */
  onError?: (err: Error) => void;
  /**
   * Timing hook for synchronous worker→host event dispatch. On the Electron
   * main process this IS main-thread blocking time, so reporting it is what
   * makes a freeze attributable to a specific event type. See MessageBridgeOpts.
   */
  onDispatch?: (type: string, ms: number) => void;
}

export type WorkerHostStatus = 'idle' | 'starting' | 'running' | 'evicting' | 'crashed';

export class WorkerHost<TWorkerData = unknown> {
  private worker: WorkerType | null = null;
  private bridge: MessageBridge | null = null;
  private restartCount = 0;
  private status: WorkerHostStatus = 'idle';
  private plannedExit = false;
  private startPromise: Promise<void> | null = null;
  private readonly opts: Required<Pick<WorkerHostOpts, 'maxRestarts' | 'restartBackoffMs' | 'defaultRequestTimeoutMs'>> & WorkerHostOpts<TWorkerData>;

  constructor(opts: WorkerHostOpts<TWorkerData>) {
    this.opts = {
      maxRestarts: opts.maxRestarts ?? 3,
      restartBackoffMs: Math.min(opts.restartBackoffMs ?? 500, 8000),
      defaultRequestTimeoutMs: opts.defaultRequestTimeoutMs ?? 30_000,
      ...opts,
    };
  }

  /** Current lifecycle phase. */
  get state(): WorkerHostStatus {
    return this.status;
  }

  /** `true` once the worker is up and bridge is ready. */
  isRunning(): boolean {
    return this.status === 'running' && !!this.bridge;
  }

  /**
   * Spawn the worker if not yet started. Returns the same promise for
   * concurrent callers so multiple `start()` calls share one boot.
   */
  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startOnce();
    return this.startPromise;
  }

  /** Underlying bridge — null until `start()` resolves. */
  get messageBridge(): MessageBridge | null {
    return this.bridge;
  }

  /**
   * Convenience: throw if not running. Use in code paths that assume
   * a started host (e.g. POST handlers that just spawned the worker).
   */
  requireBridge(): MessageBridge {
    if (!this.bridge) {
      throw new Error(`WorkerHost(${this.opts.name ?? '?'}) not running (state=${this.status})`);
    }
    return this.bridge;
  }

  /**
   * Graceful shutdown: send a `stop` request (the worker is expected
   * to flush + exit cleanly) and wait for the actual exit event.
   * Marks `plannedExit` so the exit handler doesn't try to restart.
   * Falls back to `worker.terminate()` if the worker doesn't exit
   * within `gracePeriodMs`.
   */
  async evict(gracePeriodMs = 5_000): Promise<void> {
    if (this.status !== 'running') return;
    this.status = 'evicting';
    this.plannedExit = true;
    if (this.bridge) {
      try {
        await this.bridge.request('stop', {}, { timeoutMs: gracePeriodMs });
      } catch {
        // Worker may not have a `stop` handler, or may have closed
        // the port already. Either way, fall through to terminate.
      }
    }
    if (this.worker) {
      // Wait briefly for clean exit, then force-terminate.
      const w = this.worker;
      const exited = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), gracePeriodMs);
        w.once('exit', () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      if (!exited) {
        try { await w.terminate(); } catch { /* best-effort */ }
      }
    }
    this.cleanup();
    this.status = 'idle';
  }

  private async startOnce(): Promise<void> {
    this.status = 'starting';
    this.plannedExit = false;
    const worker = new Worker(this.opts.workerFile, {
      workerData: this.opts.workerData,
      execArgv: this.opts.execArgv,
      resourceLimits: this.opts.resourceLimits,
    });
    this.worker = worker;
    this.bridge = new MessageBridge({
      // Worker has the `on`/`postMessage` interface MessageBridge needs.
      port: worker as unknown as MessageBridgeOpts['port'],
      defaultTimeoutMs: this.opts.defaultRequestTimeoutMs,
      onListenerError: (err) => {
        this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
      },
      onDispatch: this.opts.onDispatch,
    });
    worker.on('error', (err) => {
      this.opts.onError?.(err);
    });
    worker.on('exit', (code) => {
      const planned = this.plannedExit;
      this.opts.onExit?.(code, planned);
      this.cleanup();
      if (planned) {
        this.status = 'idle';
        return;
      }
      if (this.restartCount >= this.opts.maxRestarts) {
        this.status = 'crashed';
        this.opts.onCrash?.(
          new Error(
            `Worker ${this.opts.name ?? this.opts.workerFile} exited with code ${code} ` +
            `after ${this.restartCount} restart attempts.`,
          ),
        );
        return;
      }
      this.restartCount += 1;
      const delay = Math.min(
        this.opts.restartBackoffMs * 2 ** (this.restartCount - 1),
        8_000,
      );
      setTimeout(() => {
        this.startPromise = null;
        // Fire and forget — caller observes via state / next request.
        void this.start().catch((err) => {
          this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
        });
      }, delay);
    });

    // Wait for the worker to signal readiness. The worker entry MUST
    // emit an event of type `worker.ready` after wiring its handlers.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Worker ${this.opts.name ?? '?'} did not signal ready within 30s`));
      }, 30_000);
      const off = this.bridge!.on('worker.ready', () => {
        clearTimeout(timer);
        off();
        resolve();
      });
    });
    this.status = 'running';
  }

  private cleanup(): void {
    if (this.bridge) {
      try { this.bridge.dispose(); } catch { /* best-effort */ }
      this.bridge = null;
    }
    this.worker = null;
    this.startPromise = null;
  }
}
