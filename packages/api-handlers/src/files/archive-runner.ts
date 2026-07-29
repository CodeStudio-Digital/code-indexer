/**
 * Main-process side of the archive worker: spawns one short-lived thread per
 * job, adapts its messages into an `AsyncIterable` of progress frames, and owns
 * the cancel flag.
 *
 * One-shot rather than a pool: zip is a rare, user-initiated action, so ~30–50 ms
 * of spawn cost is noise next to a multi-second archive, and letting the thread
 * exit returns adm-zip's whole-archive Buffer to the OS instead of leaving a
 * high-water mark in a long-lived heap. (The existing `@mcp/worker-pool` is
 * wrong here for the opposite reason — it pre-warms and keeps workers alive —
 * and the indexer's pool resolves its `pending` entry on ANY message carrying a
 * reqId, so a progress frame would resolve the job early with `undefined`.)
 */
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { ArchiveWorkerJob, ArchiveWorkerMessage } from './archive-worker.js';

export interface ArchiveProgress {
  files: number;
  totalFiles: number;
  bytes: number;
  totalBytes: number;
  done: boolean;
}

export class ArchiveError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ArchiveError';
    this.code = code;
  }
}

/**
 * Resolve the worker entry for both runtimes. Compiled (`.js` caller) → sibling
 * `.js`. Source (`.ts` caller, i.e. tsx dev) → the local `_dev-bootstrap.mjs`,
 * which registers tsx inside the thread and imports the real `.ts`.
 */
function workerSpec(): { url: URL; bootstrapData?: { tsEntry: string } } {
  if (import.meta.url.endsWith('.ts')) {
    return {
      url: new URL('./_dev-bootstrap.mjs', import.meta.url),
      bootstrapData: { tsEntry: fileURLToPath(new URL('./archive-worker.ts', import.meta.url)) },
    };
  }
  return { url: new URL('./archive-worker.js', import.meta.url) };
}

/** In-flight jobs, so `cancel(archiveId)` can reach the right worker. */
const inFlight = new Map<string, { flag: Int32Array; worker: Worker }>();

/** Signal a running job to stop. No-op for an unknown/finished id. */
export function cancelArchive(archiveId: string): boolean {
  const job = inFlight.get(archiveId);
  if (!job) return false;
  // Shared memory, not postMessage: the worker is inside synchronous adm-zip
  // code and never drains its message queue. See archive-worker.ts.
  Atomics.store(job.flag, 0, 1);
  return true;
}

/**
 * Run a job, yielding progress until it completes. Throws `ArchiveError` on
 * failure; returns normally (with a final `done: true` frame) on success.
 * A cancelled job ends the stream without throwing — the caller asked for it.
 *
 * The worker is terminated in `finally`, which covers the caller abandoning the
 * iterator early (`break`, or an error downstream) as well as normal completion.
 */
export async function* runArchiveJob(archiveId: string, job: ArchiveWorkerJob): AsyncGenerator<ArchiveProgress> {
  const spec = workerSpec();
  const cancel = new SharedArrayBuffer(4);
  const flag = new Int32Array(cancel);
  const worker = new Worker(spec.url, {
    workerData: { job, cancel, ...(spec.bootstrapData ?? {}) },
  });
  inFlight.set(archiveId, { flag, worker });

  // Buffer frames between yields: the worker posts faster than a consumer
  // awaits, and dropping frames would make the progress bar jump.
  const queue: ArchiveWorkerMessage[] = [];
  let wake: (() => void) | null = null;
  const push = (m: ArchiveWorkerMessage): void => {
    queue.push(m);
    wake?.();
    wake = null;
  };

  worker.on('message', push);
  worker.on('error', (err) => push({ type: 'error', code: 'archive_failed', message: err.message }));
  worker.on('exit', (code) => {
    // A worker that dies without reporting (OOM, hard crash) must not hang the
    // consumer waiting for a frame that will never arrive.
    if (queue.length === 0 || queue[queue.length - 1].type === 'progress') {
      push({ type: 'error', code: 'archive_worker_exit', message: `archive worker exited with code ${code}` });
    }
  });

  try {
    for (;;) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      const msg = queue.shift()!;
      if (msg.type === 'progress') {
        yield { files: msg.files, totalFiles: msg.totalFiles, bytes: msg.bytes, totalBytes: msg.totalBytes, done: false };
        continue;
      }
      if (msg.type === 'done') {
        yield { files: msg.files, totalFiles: msg.files, bytes: msg.bytes, totalBytes: msg.bytes, done: true };
        return;
      }
      if (msg.type === 'cancelled') return;
      throw new ArchiveError(msg.code, msg.message);
    }
  } finally {
    inFlight.delete(archiveId);
    void worker.terminate();
  }
}

/** Drain a job to completion, ignoring progress. For non-UI callers. */
export async function runArchiveJobToEnd(archiveId: string, job: ArchiveWorkerJob): Promise<{ files: number; bytes: number }> {
  let last: ArchiveProgress | null = null;
  for await (const p of runArchiveJob(archiveId, job)) last = p;
  return { files: last?.files ?? 0, bytes: last?.bytes ?? 0 };
}
