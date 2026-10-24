import { expect, it } from 'vitest';
import { runScriptAsync } from '../async.js';
import type { RunCtx } from '../index.js';
const context = (): RunCtx => ({ phase: 'pre', variables: {}, cookies: new Map(), request: { method: 'GET', url: '/', headers: {}, body: '' } });

it('applies variable and request changes through serialized values', async () => {
  const ctx = context();
  const result = await runScriptAsync(ctx, 'pm.environment.set("id", "42"); pm.request.method = "POST";');
  expect(result.error).toBeUndefined(); expect(ctx.variables.id).toBe('42'); expect(ctx.request.method).toBe('POST');
});

it('keeps the control loop responsive and cancels a runaway script without applying partial changes', async () => {
  const ctx = context(), controller = new AbortController();
  let ticks = 0;
  const interval = setInterval(() => ticks++, 10), timer = setTimeout(() => controller.abort(new Error('stop script')), 100);
  const started = performance.now();
  try {
    await expect(runScriptAsync(ctx, 'pm.environment.set("unsafe", "partial"); while (true) {}', controller.signal)).rejects.toThrow('stop script');
    expect(ticks).toBeGreaterThanOrEqual(2); expect(performance.now() - started).toBeLessThan(1000);
    expect(ctx.variables).toEqual({});
    expect((await runScriptAsync(context(), 'console.log("next");')).consoleLogs).toEqual(['next']);
  } finally { clearTimeout(timer); clearInterval(interval); }
});

it('exposes no Node or async capabilities to the script', async () => {
  const result = await runScriptAsync(context(), 'console.log(typeof process, typeof require, typeof Promise, typeof setTimeout);');
  expect(result.consoleLogs).toEqual(['undefined undefined undefined undefined']);
});

it('does not report a deferred assertion as passing', async () => {
  const result = await runScriptAsync(context(), 'pm.test("deferred", async () => { throw new Error("fail"); });');
  expect(result.tests).toEqual([{ name: 'deferred', passed: false, error: 'Async pm.test callbacks are not supported' }]);
});
