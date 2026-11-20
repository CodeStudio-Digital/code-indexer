import { describe, expect, it } from 'vitest';
import { superviseCodeExec, WATCHDOG_BUDGET_MARGIN_MS } from '../code-exec-supervisor.js';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function supervise(code: string, invoke: () => Promise<unknown>) {
  return superviseCodeExec({
    code: `(async () => { ${code} })()`, timeoutMs: 500,
    maxOutputBytes: 1024, priorityErrorBytes: 256,
    tools: ['read_step'], schemas: [], listing: [], changes: [], stash: [],
  }, { invoke, ready() {}, log() {}, logOmission() {}, stash() {} });
}

describe('code_exec supervisor liveness', () => {
  it('does not blame the evaluator when the owning event loop stalls past the heartbeat budget', async () => {
    const run = supervise('return await tools.read_step({});', async () => {
      // A synchronous host filesystem scan delays timers AND pipe delivery.
      // The child stays alive and sends heartbeats while the parent is blocked.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 850);
      await sleep(100);
      return 'read completed';
    });
    try { await expect(run.promise).resolves.toBe('read completed'); }
    finally { await run.close(); }
  });

  it('declares a stuck evaluator only after a margin past the script budget', async () => {
    // The host budget clock is armed on `ready` with the same 500 ms. A spin
    // after the first await blocks the child's vm timeout and heartbeats, so
    // only the watchdog can fire here; it must leave the budget room to win.
    let readyAt = 0;
    const run = superviseCodeExec({
      code: '(async () => { await Promise.resolve(); while (true) {} })()', timeoutMs: 500,
      maxOutputBytes: 1024, priorityErrorBytes: 256,
      tools: [], schemas: [], listing: [], changes: [], stash: [],
    }, { invoke: async () => null, ready() { readyAt = performance.now(); }, log() {}, logOmission() {}, stash() {} });
    try {
      await expect(run.promise).rejects.toMatchObject({ code: 'CODE_EXEC_JS_TIMEOUT', message: 'code_exec timed out waiting for the evaluator to respond' });
      const elapsed = performance.now() - readyAt;
      expect(elapsed).toBeGreaterThanOrEqual(500 + WATCHDOG_BUDGET_MARGIN_MS - 5);
      expect(elapsed).toBeLessThan(500 + WATCHDOG_BUDGET_MARGIN_MS + 2_000);
    } finally { await run.close(); }
  });

  it('still stops a post-await infinite loop in the evaluator', async () => {
    const run = supervise('await tools.read_step({}); while (true) {}', async () => 'read completed');
    try { await expect(run.promise).rejects.toMatchObject({ code: 'CODE_EXEC_JS_TIMEOUT' }); }
    finally { await run.close(); }
  });
});
