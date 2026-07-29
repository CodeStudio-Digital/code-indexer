/**
 * Worker side of runtime detection: run the synchronous per-kind detector and
 * post the result back. One thread per call, then exit — detection is a rare,
 * user-triggered action, so ~30-50ms of spawn cost is noise next to the probes
 * themselves (up to 2.5s each), and letting the thread die returns whatever the
 * detectors allocated to the OS. Same one-shot rationale as archive-runner.ts.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { ApiError } from '@mcp/api-bus';
import type { Runtime, RuntimeKind } from '@mcp/api-bus';
import { listFor } from './detect-all.js';

export interface DetectWorkerJob {
  kind: RuntimeKind;
  dataDir: string;
}

export type DetectWorkerMessage =
  | { type: 'done'; runtimes: Runtime[] }
  | { type: 'error'; code: string; status: number; message: string };

const port = parentPort;
if (!port) throw new Error('[runtime/detect-worker] must run as a worker thread');

const job = workerData?.job as DetectWorkerJob | undefined;
if (!job) {
  const msg: DetectWorkerMessage = {
    type: 'error',
    code: 'internal',
    status: 500,
    message: 'missing workerData.job',
  };
  port.postMessage(msg);
} else {
  try {
    const runtimes = listFor(job.kind, job.dataDir);
    port.postMessage({ type: 'done', runtimes } satisfies DetectWorkerMessage);
  } catch (err) {
    // ApiError carries the status the route should surface; anything else is a
    // genuine bug in a detector and becomes a 500.
    const msg: DetectWorkerMessage =
      err instanceof ApiError
        ? { type: 'error', code: err.code, status: err.status, message: err.message }
        : { type: 'error', code: 'internal', status: 500, message: (err as Error)?.message ?? String(err) };
    port.postMessage(msg);
  }
}
