/**
 * Worker side of runtime detection: run the synchronous per-kind detector and
 * post the result back. One thread per call, then exit — detection is a rare,
 * user-triggered action, so ~30-50ms of spawn cost is noise next to the probes
 * themselves (up to 2.5s each), and letting the thread die returns whatever the
 * detectors allocated to the OS. Same one-shot rationale as archive-runner.ts.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { ApiError } from '@mcp/api-bus';
import type { PreflightReport, Runtime, RuntimeKind } from '@mcp/api-bus';
import { listFor } from './detect-all.js';

export type DetectWorkerJob = { kind: RuntimeKind; dataDir: string } | { dbPath: string };

export type DetectWorkerMessage =
  | { type: 'done'; value: Runtime[] | PreflightReport }
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
    let value: Runtime[] | PreflightReport;
    if ('dbPath' in job) {
      const { runPreflight } = await import('@mcp/services/preflight/index.js');
      value = await runPreflight({ dbPath: job.dbPath });
    } else {
      value = listFor(job.kind, job.dataDir);
    }
    port.postMessage({ type: 'done', value } satisfies DetectWorkerMessage);
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
