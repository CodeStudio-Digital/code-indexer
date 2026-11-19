import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { killProcessTree, trackProcessTree } from '@mcp/shared/utils/process-tree.js';
import type { GitProcessInput, GitResult } from './git-process.js';
import { isReadOnlyGit, type GitReadRequest, type GitReadResponse } from './git-read-protocol.js';

const CONCURRENCY = 4;
const MAX_PENDING = 64;
const LOCATION_FLAGS = new Set(['--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir']);
function isLocationRead(args: string[]): boolean {
  return (args[0] === 'worktree' && args[1] === 'list')
    || (args[0] === 'rev-parse' && args.length > 1 && args.slice(1).every(arg => LOCATION_FLAGS.has(arg)));
}
const failed = (message: string): GitResult => ({ code: -1, stdout: '', stderr: message, errorCode: 'spawn_failed' });
const timeout = (ms: number): GitResult => ({ code: -1, stdout: '', stderr: `Git read timed out after ${ms}ms`, timedOut: true, errorCode: 'timeout' });

interface Pending {
  id: number; input: GitProcessInput; pid: Int32Array; resolve(result: GitResult): void;
  deadline: number; started: boolean; expired: boolean; locationRead: boolean; reserved?: boolean; untrack?: () => void;
  timer?: ReturnType<typeof setTimeout>; detachAbort?: () => void;
}

function createWorker(): Worker {
  return import.meta.url.endsWith('.ts')
    ? new Worker(new URL('../files/_dev-bootstrap.mjs', import.meta.url), {
      workerData: { tsEntry: fileURLToPath(new URL('./git-read-worker.ts', import.meta.url)) },
    })
    : new Worker(new URL('./git-read-worker.js', import.meta.url));
}

/** One reusable thread owns read spawns; never fall back to blocking the host. */
export class GitReadExecutor {
  private worker: Worker | null = null;
  private sequence = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly queue: Pending[] = [];
  private active = 0;
  private reservedActive = false;
  private shutdown: Promise<void> | null = null;
  private failing: Promise<void> | null = null;
  private closing = false;
  private exited: Promise<void> = Promise.resolve();
  constructor(private readonly factory: () => Worker = createWorker) {}

  run(input: GitProcessInput, signal?: AbortSignal): Promise<GitResult> {
    if (signal?.aborted) return Promise.resolve(failed('Git read cancelled'));
    if (this.closing || this.failing) return Promise.resolve(failed('Git read worker is shutting down'));
    if (!isReadOnlyGit(input.args)) return Promise.resolve(failed('Git worker accepts only read commands'));
    const locationRead = isLocationRead(input.args);
    if (this.pending.size >= MAX_PENDING + (locationRead ? CONCURRENCY : 0)) return Promise.resolve(failed('Git read queue is full'));
    try { this.ensureWorker(); } catch (error) { return Promise.resolve(failed(`Git read worker failed: ${String(error)}`)); }
    this.worker!.ref();
    return new Promise(resolve => {
      const job: Pending = { id: ++this.sequence, input, resolve, pid: new Int32Array(new SharedArrayBuffer(4)),
        started: false, expired: false, locationRead, deadline: input.timeoutMs > 0 ? Date.now() + input.timeoutMs : 0 };
      this.pending.set(job.id, job); this.queue.push(job);
      const cancel = (result: GitResult) => {
        if (job.expired) return;
        job.expired = true;
        job.resolve(result);
        if (job.started) this.post({ type: 'cancel', id: job.id });
        else {
          const index = this.queue.indexOf(job);
          if (index >= 0) this.queue.splice(index, 1);
          this.finish(job, result);
        }
        // A started job remains owned and keeps the worker alive until close.
      };
      if (signal) {
        const abort = () => cancel(failed('Git read cancelled'));
        signal.addEventListener('abort', abort, { once: true });
        job.detachAbort = () => signal.removeEventListener('abort', abort);
      }
      if (input.timeoutMs > 0) job.timer = setTimeout(() => cancel(timeout(input.timeoutMs)), input.timeoutMs);
      this.pump();
    });
  }

  private ensureWorker(): void {
    if (this.worker) return;
    const worker = this.factory();
    this.worker = worker;
    this.exited = new Promise(resolve => worker.once('exit', () => resolve()));
    worker.on('message', (message: GitReadResponse) => {
      const job = this.pending.get(message.id);
      if (!job) return;
      if (message.type === 'spawned') {
        if (Atomics.load(job.pid, 0) === message.pid && !job.untrack) job.untrack = trackProcessTree(message.pid);
        return;
      }
      this.finish(job, message.result);
    });
    worker.once('error', error => { void this.fail(worker, `Git read worker failed: ${error.message}`); });
    worker.once('exit', code => {
      if (this.worker === worker) void this.fail(worker, `Git read worker exited with code ${code}`);
    });
  }

  private post(message: GitReadRequest): void {
    try { this.worker?.postMessage(message); }
    catch (error) { if (this.worker) void this.fail(this.worker, `Git read worker message failed: ${String(error)}`); }
  }

  private pump(): void {
    while (this.worker && !this.closing && this.queue.length) {
      // A diff or status on a large checkout can occupy all ordinary slots.
      // Reserve one additional process solely for locating/listing checkouts.
      const reserve = this.active - Number(this.reservedActive) >= CONCURRENCY;
      if (reserve && this.reservedActive) break;
      const index = reserve ? this.queue.findIndex(item => item.locationRead) : 0;
      if (index < 0) break;
      const [job] = this.queue.splice(index, 1);
      if (!job) break;
      if (!this.pending.has(job.id)) continue;
      const remaining = job.deadline ? job.deadline - Date.now() : 0;
      if (job.deadline && remaining <= 0) { this.finish(job, timeout(job.input.timeoutMs)); continue; }
      job.started = true; this.active++;
      if (reserve) { job.reserved = true; this.reservedActive = true; }
      this.post({ type: 'run', id: job.id, input: { ...job.input, timeoutMs: remaining }, pid: job.pid.buffer as SharedArrayBuffer });
    }
    if (!this.pending.size && this.worker && !this.closing) {
      this.worker.unref();
      // Keep one warm thread, with no Git children or polling timer in idle.
      // Retiring between polls introduces a request/shutdown race and respawns.
    }
  }

  private finish(job: Pending, result: GitResult): void {
    if (!this.pending.delete(job.id)) return;
    if (job.timer) clearTimeout(job.timer);
    job.detachAbort?.();
    job.untrack?.(); Atomics.store(job.pid, 0, 0);
    if (job.started) this.active--;
    if (job.reserved) this.reservedActive = false;
    if (!job.expired) job.resolve(result);
    this.pump();
  }

  private async fail(worker: Worker, message: string): Promise<void> {
    if (this.worker !== worker) return;
    this.worker = null;
    let complete!: () => void;
    this.failing = new Promise<void>(resolve => { complete = resolve; });
    const jobs = [...this.pending.values()];
    // Read shared PIDs as well as delivered spawn messages: a worker can die
    // between native spawn and message delivery. Never replay a command.
    try {
      await Promise.all(jobs.map(async job => {
        const pid = Atomics.load(job.pid, 0);
        if (pid > 0) {
          job.untrack ??= trackProcessTree(pid);
          await killProcessTree(pid, 'SIGKILL');
          // The shared slot is cleared by normal close. Recheck after an
          // asynchronous tree kill before falling back to the direct owner.
          if (Atomics.load(job.pid, 0) === pid) try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
        }
        this.finish(job, failed(message));
      }));
      this.queue.length = 0;
      await worker.terminate();
    } finally { complete(); this.failing = null; }
  }

  dispose(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    const worker = this.worker;
    if (!worker) return this.failing ?? Promise.resolve();
    this.closing = true;
    // Emergency process-exit callers cannot wait for queued spawn messages.
    // Publish any already-created PID to the host registry synchronously.
    for (const job of this.pending.values()) {
      const pid = Atomics.load(job.pid, 0);
      if (pid > 0) job.untrack ??= trackProcessTree(pid);
    }
    this.shutdown = (async () => {
      for (const job of this.queue.splice(0)) this.finish(job, failed('Git read worker is shutting down'));
      // Cooperative disposal waits for the actual child close before thread exit.
      worker.ref(); this.post({ type: 'dispose' });
      await this.exited;
      if (this.worker === worker) await this.fail(worker, 'Git read worker closed');
      await this.failing;
    })().finally(() => { this.shutdown = null; this.closing = false; });
    return this.shutdown;
  }
}

const reader = new GitReadExecutor();
export const runGitRead = (input: GitProcessInput, signal?: AbortSignal): Promise<GitResult> => reader.run(input, signal);
export const disposeGitReadWorker = (): Promise<void> => reader.dispose();
