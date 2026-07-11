/**
 * Dev-mode worker bootstrap.
 *
 * `tsx/esm` has a hard guard that skips registration when
 * `worker_threads.isMainThread === false`, so spawning a worker with
 * `--import tsx/esm` does NOT enable TS resolution inside the worker.
 * We work around that by spawning THIS file instead — pure ESM JS
 * Node can load without any loader — and using a namespaced
 * `tsx/esm/api.register()` explicitly. The namespace scopes resolution to the
 * TypeScript worker graph and preserves its ESM import context instead of
 * installing the process-wide fallback. That matters for installed ESM plugin
 * bundles: they live outside the repository package scope and an unscoped tsx
 * hook can re-enter their `.js` entry through CommonJS, producing
 * ERR_REQUIRE_CYCLE_MODULE in Node 24.
 *
 * `workerData.tsEntry` is the absolute path to the real worker file
 * (`company-worker.ts` or `coder-worker.ts`), set by the pool.
 *
 * In production (`npm run build`) the pool resolves to the compiled
 * `.js` directly and never touches this file.
 */
import { workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';

const entry = workerData?.tsEntry;
if (typeof entry !== 'string' || !entry) {
  throw new Error('[_dev-bootstrap.mjs] missing workerData.tsEntry — pool misconfigured');
}

// Register tsx as an ESM loader for THIS thread. A namespaced registration
// exposes a scoped import function without installing the process-wide fallback
// that misclassifies package-less plugin bundles.
const tsx = register({ namespace: 'mcp-http-worker' });

// Hand off to the real worker through the scoped loader. Transitive TS imports
// remain in the namespace, while dynamic imports of ordinary JS do not.
await tsx.import(pathToFileURL(entry).href, import.meta.url);
