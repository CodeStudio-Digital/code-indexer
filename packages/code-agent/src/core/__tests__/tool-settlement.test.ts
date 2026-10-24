import { setImmediate as nextEventLoop } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import { ToolRegistry } from '../registry.js';
import type { ToolSettledEvent } from '../tool.js';

it('returns the handler result before auxiliary work and isolates normalized input/result snapshots', async () => {
  const registry = new ToolRegistry();
  const result = { content: 'committed', isError: false };
  registry.register({ name: 'create_file', source: 'native', description: 'fixture',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
    handler: async args => { expect(args.path).toBe('original'); args.path = 'handler-local'; return result; } });
  let release!: () => void;
  const slow = new Promise<void>(resolve => { release = resolve; });
  const observer = vi.fn(async (event: ToolSettledEvent) => {
    expect(event.toolArgs.path).toBe('original');
    (event.result as { isError: boolean }).isError = true;
    await slow;
    throw new Error('index unavailable');
  });
  expect(await registry.invoke('create_file', { path: 'original' }, { cwd: '.', projectName: 'fixture', onToolSettled: observer })).toBe(result);
  expect(observer).not.toHaveBeenCalled();
  await nextEventLoop();
  expect(observer).toHaveBeenCalledOnce();
  expect(result).toEqual({ content: 'committed', isError: false });
  release();
  await nextEventLoop();
});

it('observes handler failure once but does not report unknown tools as executed', async () => {
  const registry = new ToolRegistry();
  registry.register({ name: 'fixture', source: 'native', description: 'fixture',
    parameters: { type: 'object', properties: {} }, handler: async () => { throw new Error('failed effect'); } });
  const observer = vi.fn();
  const context = { cwd: '.', projectName: 'fixture', onToolSettled: observer };
  expect(await registry.invoke('missing', {}, context)).toMatchObject({ isError: true });
  expect(await registry.invoke('fixture', {}, context)).toMatchObject({ isError: true });
  await nextEventLoop();
  expect(observer).toHaveBeenCalledOnce();
  expect(observer.mock.calls[0]![0]).toMatchObject({ toolName: 'fixture', result: { isError: true } });
});
