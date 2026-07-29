/**
 * Dev-mode worker bootstrap for the archive worker.
 *
 * `tsx/esm` has a hard guard that skips registration when
 * `worker_threads.isMainThread === false`, so spawning a `.ts` worker from a
 * tsx-run process fails on its first aliased import. Same fix as
 * packages/indexer/src/workers/_dev-bootstrap.mjs and
 * apps/http-api/workers/_dev-bootstrap.mjs: spawn THIS plain-ESM file (loads
 * with zero loaders), register tsx for this thread via the explicit API (which
 * bypasses the main-thread guard), then dynamic-import the real `.ts` entry
 * passed in `workerData.tsEntry`.
 *
 * In production the runner resolves the compiled `.js` directly and this file
 * is never touched.
 */
import { workerData } from 'node:worker_threads';
import { register } from 'tsx/esm/api';

const entry = workerData?.tsEntry;
if (typeof entry !== 'string' || !entry) {
  throw new Error('[api-handlers/files/_dev-bootstrap.mjs] missing workerData.tsEntry');
}

register();

await import(`file://${entry.replace(/\\/g, '/')}`);
