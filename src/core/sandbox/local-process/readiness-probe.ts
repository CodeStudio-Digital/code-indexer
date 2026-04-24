/**
 * HTTP readiness probe — poll `http://127.0.0.1:<port><path>` until the
 * server answers with anything that is NOT a connection error. We
 * intentionally accept any HTTP status (including 404) because dev
 * servers that redirect `/` to an app shell often return 3xx/4xx while
 * fully functional. A 5xx coming back means the process is alive too.
 *
 * Three terminal outcomes:
 *   - `{ ok: true }`  — got an HTTP reply before the deadline.
 *   - `{ ok: false, reason: 'aborted' }` — parent gave up (user cancel).
 *   - `{ ok: false, reason: 'timeout' }` — deadline elapsed, no reply.
 *
 * Why no HEAD fallback: many dev servers don't handle HEAD. We use GET
 * and discard the body.
 */

import { request as httpRequest } from 'node:http';

export interface ProbeOptions {
  port: number;
  /** URL path — must start with '/'. Defaults to '/'. */
  path?: string;
  /** Overall deadline in ms. Defaults to 30s. */
  timeoutMs?: number;
  /** Interval between individual attempts. Defaults to 500ms. */
  intervalMs?: number;
  signal?: AbortSignal;
}

export type ProbeResult = { ok: true } | { ok: false; reason: 'aborted' | 'timeout' };

export async function httpReadinessProbe(opts: ProbeOptions): Promise<ProbeResult> {
  const path = opts.path ?? '/';
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) return { ok: false, reason: 'aborted' };
    const attempt = await tryOnce(opts.port, path, Math.min(2_000, deadline - Date.now()));
    if (attempt) return { ok: true };
    await sleep(intervalMs, opts.signal);
  }
  return { ok: false, reason: 'timeout' };
}

function tryOnce(port: number, path: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port, method: 'GET', path, timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(true);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        resolve();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
