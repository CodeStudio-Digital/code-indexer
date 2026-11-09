import { describe, expect, it } from 'vitest';
import { superviseCodeExec } from '../code-exec-supervisor.js';

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

  it('still stops a post-await infinite loop in the evaluator', async () => {
    const run = supervise('await tools.read_step({}); while (true) {}', async () => 'read completed');
    try { await expect(run.promise).rejects.toMatchObject({ code: 'CODE_EXEC_JS_TIMEOUT' }); }
    finally { await run.close(); }
  });
});
