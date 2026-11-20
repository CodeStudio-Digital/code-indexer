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
  /** Maximum wait for worker.ready. Default 30s. */
  readyTimeoutMs?: number;
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
  private stopPromise: Promise<void> | null = null;
  private workerExit: Promise<void> = Promise.resolve();
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
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
    if (this.stopPromise || (this.worker && this.plannedExit)) {
      return this.evict().then(() => this.start());
    }
    if (this.startPromise) return this.startPromise;
    this.cancelRestart();
    const boot = this.startOnce();
    this.startPromise = boot;
    // A synchronous Worker constructor failure has no exit event to reset the host.
    void boot.catch(() => {
      if (!this.worker && this.startPromise === boot) this.startPromise = null;
    });
    return boot;
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
  evict(gracePeriodMs = 5_000): Promise<void> {
    this.cancelRestart();
    if (this.stopPromise) return this.stopPromise;
    if (!this.worker) {
      this.status = 'idle';
      return Promise.resolve();
    }
    const wasStarting = this.status === 'starting';
    this.status = 'evicting';
    this.plannedExit = true;
    const stop = this.stopWorker(this.worker, this.workerExit, wasStarting ? 0 : gracePeriodMs);
    this.stopPromise = stop;
    const settled = () => { if (this.stopPromise === stop) this.stopPromise = null; };
    void stop.then(settled, settled);
    return stop;
  }

  private async stopWorker(worker: WorkerType, exited: Promise<void>, graceMs: number): Promise<void> {
    if (graceMs > 0 && this.bridge) {
      // An acknowledgement can be lost or arrive before the thread exits. Both
      // phases share one deadline; only the physical exit releases ownership.
      void this.bridge.request('stop', {}, { timeoutMs: graceMs }).catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(resolve, graceMs); })]);
      } finally { clearTimeout(timer); }
    }
    if (worker.threadId !== -1) {
      try { await worker.terminate(); }
      catch (error) { if (this.worker === worker && worker.threadId !== -1) throw error; }
    }
    await exited;
  }

  private cancelRestart(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private async startOnce(): Promise<void> {
    const worker = new Worker(this.opts.workerFile, {
      workerData: this.opts.workerData,
      execArgv: this.opts.execArgv,
      resourceLimits: this.opts.resourceLimits,
    });
    this.status = 'starting';
    this.plannedExit = false;
    this.worker = worker;
    const bridge = new MessageBridge({
      // Worker has the `on`/`postMessage` interface MessageBridge needs.
      port: worker as unknown as MessageBridgeOpts['port'],
      defaultTimeoutMs: this.opts.defaultRequestTimeoutMs,
      onListenerError: (err) => {
        this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
      },
      onDispatch: this.opts.onDispatch,
    });
    this.bridge = bridge;
    let bootError: Error | undefined;
    let rejectBoot: ((error: Error) => void) | undefined;
    let offReady!: () => void;
    let timer: ReturnType<typeof setTimeout>;
    const readyMs = this.opts.readyTimeoutMs ?? 30_000;
    const ready = new Promise<void>((resolve, reject) => {
      rejectBoot = reject;
      offReady = bridge.on('worker.ready', () => resolve());
      timer = setTimeout(() => reject(new Error(`Worker ${this.opts.name ?? '?'} did not signal ready within ${readyMs}ms`)), readyMs);
    });
    worker.on('error', err => { bootError = err; this.opts.onError?.(err); });
    this.workerExit = new Promise<void>(resolve => worker.once('exit', (code) => {
      const planned = this.plannedExit;
      rejectBoot?.(bootError ?? new Error(`Worker ${this.opts.name ?? this.opts.workerFile} exited with code ${code} before worker.ready`));
      resolve();
      this.cleanup();
      const exhausted = !planned && this.restartCount >= this.opts.maxRestarts;
      this.status = exhausted ? 'crashed' : 'idle';
      if (!planned && !exhausted) {
        const delay = Math.min(this.opts.restartBackoffMs * 2 ** this.restartCount, 8_000);
        this.restartCount += 1;
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          void this.start().catch(err => this.opts.onError?.(err instanceof Error ? err : new Error(String(err))));
        }, delay);
      }
      this.opts.onExit?.(code, planned);
      if (exhausted) this.opts.onCrash?.(bootError ?? new Error(
        `Worker ${this.opts.name ?? this.opts.workerFile} exited with code ${code} after ${this.restartCount} restart attempts.`,
      ));
    }));
    try {
      await ready;
      if (this.worker !== worker || this.plannedExit) throw new Error('Worker stopped during startup');
      this.status = 'running';
    } catch (error) {
      if (this.worker === worker && !this.plannedExit) await this.evict(0);
      throw error;
    } finally {
      rejectBoot = undefined;
      clearTimeout(timer!);
      offReady();
    }
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
