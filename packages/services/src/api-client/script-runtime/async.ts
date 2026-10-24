import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { BOOTSTRAP } from './bootstrap.js';
import { applyToCtx, type Collected, type RunCtx } from './context.js';
import { EMPTY_SCRIPT_RESULT, UNSET, type ScriptResult } from './types.js';
import { SCRIPT_WORKER_SOURCE } from './worker-source.js';

const require = createRequire(import.meta.url);
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
let activeWorkers = 0;

/** User code only reaches QuickJS's WASM memory. No host object or callback is
 * exported. Completion/abort awaits physical worker termination before return. */
export async function runScriptAsync(ctx: RunCtx, source: string, signal?: AbortSignal, timeoutMs = 2000): Promise<ScriptResult> {
  signal?.throwIfAborted();
  if (!source.trim()) return { ...EMPTY_SCRIPT_RESULT, variableUpdates: {}, consoleLogs: [], tests: [] };
  if (activeWorkers >= 8) throw new Error('API script executor is saturated; wait for active scripts');
  const input = JSON.stringify({ ...ctx, cookies: [...ctx.cookies], response: ctx.response ?? null, UNSET });
  if (Buffer.byteLength(input) + Buffer.byteLength(source) > MAX_INPUT_BYTES) throw new Error('API script input exceeds 16 MiB');
  const timeout = Number.isFinite(timeoutMs) ? Math.min(5000, Math.max(100, timeoutMs)) : 2000;
  const started = performance.now();
  activeWorkers++;
  let worker: Worker | undefined;
  let raw: { collected?: Collected; error?: string };
  try {
    worker = new Worker(SCRIPT_WORKER_SOURCE, { eval: true,
      workerData: { modulePath: require.resolve('quickjs-emscripten'), bootstrap: BOOTSTRAP, input, source, timeout },
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 } });
    raw = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, value?: typeof raw) => {
        if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value ?? {});
      };
      const abort = () => finish(signal?.reason ?? new Error('API script cancelled'));
      const timer = setTimeout(() => finish(undefined, { error: 'API script worker exceeded its execution deadline' }), timeout + 3000);
      worker!.once('message', message => {
        if (typeof message !== 'string' || Buffer.byteLength(message) > MAX_INPUT_BYTES) return finish(new Error('API script result exceeds its bounded contract'));
        try { finish(undefined, JSON.parse(message)); } catch (cause) { finish(cause); }
      });
      worker!.once('error', cause => finish(cause));
      worker!.once('exit', code => finish(new Error(`API script worker exited before its result (${code})`)));
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    });
  } finally {
    try { if (worker) await worker.terminate(); } finally { activeWorkers--; }
  }
  signal?.throwIfAborted();
  const collected = raw.collected ?? {};
  applyToCtx(ctx, collected);
  return { variableUpdates: collected.variableUpdates ?? {}, requestPatch: ctx.phase === 'pre' ? collected.requestPatch : undefined,
    consoleLogs: collected.consoleLogs ?? [], tests: collected.tests ?? [], error: raw.error, durationMs: performance.now() - started };
}
