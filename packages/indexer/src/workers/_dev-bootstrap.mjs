/**
 * Dev-mode worker bootstrap for the indexer pools (indexJob, dbWriter).
 *
 * `tsx/esm` has a hard guard that skips registration when
 * `worker_threads.isMainThread === false`, so spawning a `.ts` worker in a
 * tsx-run process fails on its first aliased import ("Cannot find module
 * '@mcp/...'/src/....js"). Same fix as apps/http-api/workers/_dev-bootstrap.mjs:
 * spawn THIS plain-ESM file (loads with zero loaders), register tsx for this
 * thread via the explicit API (which bypasses the main-thread guard), then
 * dynamic-import the real `.ts` entry passed in `workerData.tsEntry`.
 *
 * In production the pool resolves the compiled `.js` directly and this file
 * is never touched.
 */
import { workerData } from 'node:worker_threads';
import { register } from 'tsx/esm/api';

const entry = workerData?.tsEntry;
if (typeof entry !== 'string' || !entry) {
  throw new Error('[indexer/_dev-bootstrap.mjs] missing workerData.tsEntry — pool misconfigured');
}

register();

await import(`file://${entry.replace(/\\/g, '/')}`);
