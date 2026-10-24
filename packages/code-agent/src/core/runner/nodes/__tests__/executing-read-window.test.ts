import { expect, it, vi } from 'vitest';
import { ToolRegistry } from '../../../registry.js';
import type { CoderTool } from '../../../tool.js';
import { dispatchTools } from '../executing-dispatch.js';
import { independentReadWindow } from '../executing-read-window.js';

const base: CoderTool = { name: 'read_probe', source: 'native', description: '',
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
  mutates: false, parallelSafe: true, riskLevel: 'read', executionClass: 'read', repeatPolicy: 'stable',
  handler: async () => ({ content: 'result' }) };
const call = (index: number, name = base.name) => ({ id: `tool:${index}`, name, input: { path: `file:${index}` } });
const context = { cwd: process.cwd(), projectName: 'read-window' };

it('overlaps four independent reads, publishes the fast result and preserves model order', async () => {
  let entered = 0, active = 0, maximum = 0, slowDone = false;
  let releaseWindow!: () => void, releaseSlow!: () => void;
  const window = new Promise<void>((resolve) => { releaseWindow = resolve; });
  const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
  const registry = new ToolRegistry();
  registry.register({ ...base, async handler(input) {
    active++; maximum = Math.max(maximum, active); entered++;
    try {
      if (entered === 4) releaseWindow();
      if (Number(String(input.path).split(':')[1]) < 4) await window;
      if (input.path === 'file:0') { await slow; slowDone = true; }
      return { content: String(input.path) };
    } finally { active--; }
  } });
  const visible: string[] = [];
  const tools = Array.from({ length: 6 }, (_, index) => call(index));
  const result = await dispatchTools({ registry, toolUses: tools, toolContext: context, turn: 1, dupCalls: new Map(),
    onToolResult(value) {
      visible.push(value.toolUseId);
      if (value.toolUseId === 'tool:1') { expect(slowDone).toBe(false); releaseSlow(); }
    },
  });
  expect(maximum).toBe(4);
  expect(visible.indexOf('tool:1')).toBeLessThan(visible.indexOf('tool:0'));
  expect(result.results.map((value) => value.toolUseId)).toEqual(tools.map((value) => value.id));
  expect(result.results.every((value) => !value.isError)).toBe(true);
});

it.each([
  { parallelSafe: false }, { mutates: true }, { interactive: true }, { executionClass: 'execute' as const },
  { riskOf: () => 'read' as const }, { effectBoundary: 'filesystem' as const },
  { repeatPolicy: 'pollable' as const }, { name: 'unclassified', parallelSafe: undefined },
])('keeps mutations, interaction, dynamic risk and unknown classifications sequential: %j', (override) => {
  const tool = { ...base, ...override };
  expect(independentReadWindow([call(0, tool.name), call(1, tool.name)], () => tool, new Map())).toBe(1);
});

it('preserves duplicate-read reuse and mutation epoch protection across windows', async () => {
  const read = vi.fn(async () => ({ content: 'read' }));
  const write = vi.fn(async () => ({ content: 'write' }));
  const registry = new ToolRegistry();
  registry.register({ ...base, handler: read });
  registry.register({ ...base, name: 'write_probe', mutates: true, parallelSafe: false,
    executionClass: 'write', riskLevel: 'write', repeatPolicy: 'mutating', handler: write });
  const tools = [call(0), { ...call(1), input: call(0).input }, call(2, 'write_probe'),
    { ...call(3, 'write_probe'), input: call(2).input }, { ...call(4, 'write_probe'), input: call(2).input },
    { ...call(5), input: call(0).input }];
  const result = await dispatchTools({ registry, toolUses: tools, toolContext: context, turn: 1, dupCalls: new Map() });
  expect(read).toHaveBeenCalledTimes(2);
  expect(write).toHaveBeenCalledTimes(2);
  expect(result.results[4]?.refusalKind).toBe('dedup');
  expect(result.results[5]?.isError).toBe(false);
});

it('ends the window before a hidden tool can change the visible working set', () => {
  const visible = new Set([base.name]);
  const hidden = { ...base, name: 'hidden_read' };
  const tools = [call(0), call(1, hidden.name), call(2)];
  expect(independentReadWindow(tools, (name) => name === base.name ? base : hidden, new Map(), visible)).toBe(1);
  expect(independentReadWindow(tools.slice(1), () => hidden, new Map(), visible)).toBe(1);
});

it('cancels a started window without entering the following interactive or mutating tool', async () => {
  const controller = new AbortController();
  const mutation = vi.fn(async () => ({ content: 'never' }));
  let entered = 0;
  const registry = new ToolRegistry();
  registry.register({ ...base, async handler(_input, ctx) {
    entered++; if (entered === 4) controller.abort();
    await new Promise<void>((resolve) => {
      if (ctx.signal?.aborted) resolve(); else ctx.signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    return { content: 'cancelled' };
  } });
  registry.register({ ...base, name: 'ask_user', interactive: true, handler: mutation });
  const tools = [...Array.from({ length: 4 }, (_, index) => call(index)), call(4, 'ask_user')];
  const result = await dispatchTools({ registry, toolUses: tools, toolContext: { ...context, signal: controller.signal },
    turn: 1, dupCalls: new Map() });
  expect(entered).toBe(4);
  expect(mutation).not.toHaveBeenCalled();
  expect(result.results[4]?.refusalKind).toBe('abort');
});
