/**
 * THROWAWAY — Onda 0 spike. Delete once the gate is answered.
 *
 * Dev-mode bootstrap for the spike's utilityProcess entry.
 *
 * In dev, main runs under `NODE_OPTIONS=--import tsx/esm` (apps/electron/dev.ts),
 * but Electron does not propagate NODE_OPTIONS into a utility process — and
 * forbids it outright in a packaged app. So we fork THIS plain-ESM file (loads
 * with zero loaders), register tsx for this process via the explicit API, then
 * import the real `.ts` entry passed as argv[0].
 *
 * Same shape as apps/http-api/workers/_dev-bootstrap.mjs, except the entry path
 * arrives via `process.argv` — `utilityProcess.fork(path, args)` has no
 * `workerData` channel.
 *
 * In production the runner resolves the compiled `.js` directly and this file
 * is never touched. Whether that dev path works at all is assertion (a).
 */
import { register } from 'tsx/esm/api';

const entry = process.argv[2];
if (typeof entry !== 'string' || !entry) {
  throw new Error('[spike/_bootstrap.mjs] missing entry path in argv[2]');
}

register();

await import(`file://${entry.replace(/\\/g, '/')}`);
