/**
 * Main-thread side of runtime detection: run one short-lived worker per call so
 * the synchronous probes in `detect-all.ts` never touch the Electron main
 * thread's event loop.
 *
 * Fail-closed, deliberately: a worker failure surfaces as an error instead of
 * silently re-running the detectors in-process. A silent fallback would put the
 * freeze right back exactly when the machine is under stress — which is the
 * failure mode this whole effort exists to remove. Set
 * `MCP_RUNTIME_DETECT_WORKER=0` to force the in-process path for debugging.
 */

import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { ApiError } from '@mcp/api-bus';
import type { Runtime, RuntimeKind } from '@mcp/api-bus';
import { listFor } from './detect-all.js';
import type { DetectWorkerJob, DetectWorkerMessage } from './detect-worker.js';

/**
 * Overall ceiling for one detection pass. Individual probes already cap at
 * 2.5s, but a kind can run several of them plus directory walks; this only
 * catches a genuinely wedged thread.
 */
const DETECT_TIMEOUT_MS = Number(process.env.MCP_RUNTIME_DETECT_TIMEOUT_MS ?? 30_000);

function workerEnabled(): boolean {
  return process.env.MCP_RUNTIME_DETECT_WORKER !== '0';
}

/**
 * Resolve the worker entry for both runtimes. Compiled (`.js` caller) → sibling
 * `.js`. Source (`.ts` caller, i.e. tsx dev) → the shared `_dev-bootstrap.mjs`,
 * which registers tsx inside the thread and imports the real `.ts`.
 */
function workerSpec(): { url: URL; bootstrapData?: { tsEntry: string } } {
  if (import.meta.url.endsWith('.ts')) {
    return {
      url: new URL('../files/_dev-bootstrap.mjs', import.meta.url),
      bootstrapData: { tsEntry: fileURLToPath(new URL('./detect-worker.ts', import.meta.url)) },
    };
  }
  return { url: new URL('./detect-worker.js', import.meta.url) };
}

/** Detect installed runtimes of one kind without blocking the caller's loop. */
export function detectRuntimes(kind: RuntimeKind, dataDir: string): Promise<Runtime[]> {
  if (!workerEnabled()) return Promise.resolve(listFor(kind, dataDir));

  const spec = workerSpec();
  const job: DetectWorkerJob = { kind, dataDir };

  return new Promise<Runtime[]>((resolve, reject) => {
    const worker = new Worker(spec.url, { workerData: { job, ...(spec.bootstrapData ?? {}) } });
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new ApiError('timeout', 504, `runtime detection for '${kind}' timed out`)));
    }, DETECT_TIMEOUT_MS);

    worker.on('message', (msg: DetectWorkerMessage) => {
      if (msg.type === 'done') finish(() => resolve(msg.runtimes));
      else finish(() => reject(new ApiError(msg.code, msg.status, msg.message)));
    });
    worker.on('error', (err) => {
      finish(() => reject(new ApiError('internal', 500, `runtime detection worker failed: ${err.message}`)));
    });
    worker.on('exit', (code) => {
      // A thread that dies without posting (OOM, hard crash) must not leave the
      // caller awaiting a message that will never arrive.
      finish(() => reject(new ApiError('internal', 500, `runtime detection worker exited with code ${code}`)));
    });
  });
}
