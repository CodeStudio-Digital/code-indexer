/**
 * Dev-mode worker bootstrap.
 *
 * `tsx/esm` has a hard guard that skips registration when
 * `worker_threads.isMainThread === false`, so spawning a worker with
 * `--import tsx/esm` does NOT enable TS resolution inside the worker.
 * We work around that by spawning THIS file instead — pure ESM JS
 * Node can load without any loader — and using `tsx/esm/api.register()`
 * explicitly. Once tsx is hooked, the worker dynamically imports the
 * actual `.ts` entry, which from that point on resolves tsconfig
 * `paths` and TypeScript syntax just like the main thread.
 *
 * `workerData.tsEntry` is the absolute path to the real worker file
 * (`company-worker.ts` or `coder-worker.ts`), set by the pool.
 *
 * In production (`npm run build`) the pool resolves to the compiled
 * `.js` directly and never touches this file.
 */
import { workerData } from 'node:worker_threads';
import { register } from 'tsx/esm/api';

const entry = workerData?.tsEntry;
if (typeof entry !== 'string' || !entry) {
  throw new Error('[_dev-bootstrap.mjs] missing workerData.tsEntry — pool misconfigured');
}

// Register tsx as an ESM loader for THIS thread. `register()` is the
// API entry that bypasses the main-thread-only guard inside the
// shorthand `tsx/esm` import.
register();

// Hand off to the real worker. Use a file:// URL so node treats it
// as a TS source path rather than a bare specifier (which would skip
// extension resolution).
await import(`file://${entry.replace(/\\/g, '/')}`);
