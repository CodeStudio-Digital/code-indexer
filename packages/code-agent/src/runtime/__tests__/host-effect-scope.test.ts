import { expect, it } from 'vitest';
import { HostEffectScope } from '../host-effect-scope.js';

it('drains older effects from a nested spawn without waiting on itself or permanently sealing the owner', async () => {
  const effects = new HostEffectScope();
  let finish!: () => void;
  const old = effects.track(() => new Promise<void>(resolve => { finish = resolve; }));
  let entered!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; });
  let drained = false;
  const spawn = effects.track(() => effects.track(async () => {
    entered(); await effects.waitForOtherEffects(); drained = true;
  }));
  await waiting; await Promise.resolve(); expect(drained).toBe(false);
  finish(); await Promise.all([old, spawn]); expect(drained).toBe(true);
  await expect(effects.track(async () => 'later')).resolves.toBe('later');
  await effects.waitForIdle(); expect(effects.activeCount).toBe(0);
});

it('cannot treat cancelled quiescence as proof that another invocation stopped', async () => {
  const effects = new HostEffectScope(); let finish!: () => void;
  const old = effects.track(() => new Promise<void>(resolve => { finish = resolve; }));
  const abort = new AbortController();
  const spawn = effects.track(async () => {
    const pending = effects.waitForOtherEffects(abort.signal); abort.abort(new Error('admission cancelled'));
    await expect(pending).rejects.toThrow('admission cancelled');
  });
  await spawn; expect(effects.activeCount).toBe(1); finish(); await old; await effects.waitForIdle();
});

it('retains real effects after cancellation until their handlers settle', async () => {
  const effects = new HostEffectScope();
  let finish!: () => void;
  const handler = effects.track(() => new Promise<void>(resolve => { finish = resolve; }));
  await Promise.resolve();
  const controller = new AbortController();
  const idle = effects.waitForIdle(controller.signal);
  controller.abort(new Error('drain timed out'));
  await expect(idle).rejects.toThrow('drain timed out');
  expect(effects.activeCount).toBe(1);
  await expect(effects.track(async () => {})).rejects.toThrow('closed');
  finish(); await handler;
  await expect(effects.waitForIdle()).resolves.toBeUndefined();
  expect(effects.activeCount).toBe(0);
});

it('waits for all admitted handlers including failures before declaring idle', async () => {
  const effects = new HostEffectScope();
  let finish!: () => void;
  const first = effects.track(() => new Promise<void>(resolve => { finish = resolve; }));
  const failed = effects.track(async () => { throw new Error('handler failed'); });
  await expect(failed).rejects.toThrow('handler failed');
  let idle = false;
  const drained = effects.waitForIdle().then(() => { idle = true; });
  await Promise.resolve(); expect(idle).toBe(false);
  finish(); await first; await drained; expect(idle).toBe(true);
});
