/**
 * Test fixture — minimal worker that exercises WorkerHost end-to-end.
 *
 * Uses plain JavaScript (no TypeScript) so the test can `new Worker(...)`
 * the file directly without needing a loader. Mirrors the contract that
 * `apps/http-api/workers/company-worker.ts` implements: emit `worker.ready`
 * after wiring, respond to `rpc` requests, exit cleanly on `stop`.
 *
 * Behavior:
 *   - `ping` → returns `{ pong: <args.0> }`
 *   - `throw` → handler throws an Error with the supplied message
 *   - `slow` → resolves after `args.0` ms (used for timeout tests)
 *   - emits one event of type `tick` 50 ms after ready (verifies the
 *     event stream in both directions)
 */
import { parentPort } from 'node:worker_threads';
import v8 from 'node:v8';

if (!parentPort) {
  throw new Error('fake-worker.mjs: not running inside a worker_thread');
}

// We use a tiny inline bridge because importing the compiled
// @mcp/orchestrator-host from a worker would require build artifacts
// the tests don't produce. The protocol is small enough to inline.
const pending = new Map();

parentPort.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.kind === 'req' && typeof msg.id === 'string' && typeof msg.type === 'string') {
    try {
      const value = await dispatch(msg.type, msg.payload);
      parentPort.postMessage({ kind: 'res', id: msg.id, ok: true, value });
    } catch (err) {
      parentPort.postMessage({
        kind: 'res',
        id: msg.id,
        ok: false,
        error: err && err.message ? err.message : String(err),
      });
    }
  }
});

async function dispatch(type, payload) {
  if (type === 'ping') return { pong: payload?.value };
  if (type === 'heapLimit') {
    return { heapLimitMB: Math.round(v8.getHeapStatistics().heap_size_limit / 1024 / 1024) };
  }
  if (type === 'throw') throw new Error(payload?.message ?? 'fake-worker boom');
  if (type === 'slow') {
    await new Promise((r) => setTimeout(r, payload?.ms ?? 50));
    return { slept: payload?.ms };
  }
  if (type === 'stop') return { ok: true };
  throw new Error(`fake-worker: unknown rpc '${type}'`);
}

// Emit `worker.ready` so WorkerHost.start() resolves.
parentPort.postMessage({
  kind: 'evt',
  type: 'worker.ready',
  seq: 1,
  payload: { fixture: true },
});

// Emit a single `tick` event after ~50ms to exercise event forwarding.
setTimeout(() => {
  parentPort.postMessage({
    kind: 'evt',
    type: 'tick',
    seq: 2,
    payload: { tick: 1 },
  });
}, 50);
