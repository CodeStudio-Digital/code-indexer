/**
 * Worker file resolution + dev-mode (tsx) detection.
 *
 * The worker pools were designed for production (`npm run build` →
 * `dist/.../workers/*-worker.js`). In dev (`npm run dev:server` →
 * `tsx watch`), the .js doesn't exist — only the .ts source. The
 * obvious "just pass --import tsx/esm to the worker" approach DOES
 * NOT work, because tsx/esm has a hard guard:
 *
 *     y(G) && isMainThread && register();  // src: tsx/dist/esm/index.mjs
 *
 * So in workers tsx silently does nothing and Node fails with
 * "Cannot find package '@mcp/...'" on the first alias import.
 *
 * The fix: in dev we spawn a tiny `.mjs` bootstrap that Node loads
 * with zero loaders. The bootstrap calls `tsx/esm/api.register()`
 * explicitly (which bypasses the isMainThread guard) and then
 * dynamic-imports the real `.ts` worker entry. The pool passes the
 * actual TS path via `workerData.tsEntry`.
 *
 * In production this whole module returns the compiled `.js` and the
 * bootstrap is never touched.
 */
import { existsSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** True when this process was started via the `tsx` loader. */
export function isRunningUnderTsx(): boolean {
  return process.execArgv.some((arg) => arg.includes('tsx'));
}

export interface ResolvedWorker {
  /** Absolute path Node should spawn — either the .js or the dev bootstrap. */
  file: string;
  /** Extra `execArgv`. Empty here — the bootstrap registers tsx itself. */
  execArgv: string[];
  /**
   * Path the dev bootstrap should dynamic-import after tsx is
   * registered. Undefined in production (the worker file IS the entry).
   */
  devTsEntry?: string;
  /** True if we resolved to the built `.js`. */
  built: boolean;
}

/**
 * Resolve a worker by name. Returns `null` when neither the built
 * `.js` nor the `.ts` source + bootstrap exist, so callers can show
 * a useful "build required" message.
 */
export function resolveWorkerFile(
  callerImportMetaUrl: string,
  workerName: string,
): ResolvedWorker | null {
  // Caller is e.g. `apps/http-api/sse/*PoolSingleton.{ts|js}`. Worker
  // files live at `apps/http-api/workers/`.
  const here = dirname(fileURLToPath(callerImportMetaUrl));
  const workersDir = resolvePath(here, '..', 'workers');
  const builtPath = resolvePath(workersDir, `${workerName}.js`);
  if (existsSync(builtPath)) {
    return { file: builtPath, execArgv: [], built: true };
  }
  if (isRunningUnderTsx()) {
    const tsEntry = resolvePath(workersDir, `${workerName}.ts`);
    const bootstrap = resolvePath(workersDir, '_dev-bootstrap.mjs');
    if (existsSync(tsEntry) && existsSync(bootstrap)) {
      // Bootstrap doesn't need any execArgv — it registers tsx itself
      // before importing the TS entry. The real entry ships via
      // `workerData.tsEntry`, set by the pool when spawning.
      return {
        file: bootstrap,
        execArgv: [],
        devTsEntry: tsEntry,
        built: false,
      };
    }
  }
  return null;
}
