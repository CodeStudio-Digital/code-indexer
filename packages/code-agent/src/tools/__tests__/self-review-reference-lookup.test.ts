import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import type { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { buildRegistryReferenceLookup } from '../self-review-reference-lookup.js';

afterEach(() => vi.useRealTimers());
function lookup(invoke: (...args: any[]) => Promise<ToolResult>, signal?: AbortSignal) {
  return buildRegistryReferenceLookup({ invoke } as unknown as ToolRegistry, { projectName: 'fixture', signal } as ToolContext);
}
describe('owned self-review reference lookup', () => {

  it('cancels on its budget and waits for the actual handler to drain', async () => {
    vi.useFakeTimers();
    let signal!: AbortSignal, release!: (result: ToolResult) => void;
    let completed = false;
    const references = lookup(async (_name, _args, context) => {
      signal = context.signal;
      return new Promise(resolve => { release = resolve; });
    });
    const pending = references.findReferences('symbol').then(result => { completed = true; return result; });
    await vi.advanceTimersByTimeAsync(5000);
    expect(signal.aborted).toBe(true);
    expect(completed).toBe(false);
    release({ content: '{"references":[]}' });
    expect(await pending).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('forwards caller cancellation and clears its timer after settlement', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const references = lookup(async (_name, _args, context) => {
      await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
      return { content: '{"references":[]}' };
    }, controller.signal);
    const pending = references.findReferences('symbol');
    controller.abort(new Error('cancelled by caller'));
    await expect(pending).rejects.toThrow('cancelled by caller');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('clears a successful lookup timer and caps reference parsing', async () => {
    vi.useFakeTimers();
    const invoke = vi.fn(async () => ({ content: JSON.stringify({ references: Array.from({ length: 1000 }, () => ({ file_path: 'a.ts', line: 3 })) }) }));
    expect(await lookup(invoke).findReferences('symbol')).toHaveLength(200);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('degrades malformed data without hiding caller cancellation', async () => {
    expect(await lookup(async () => ({ content: '{bad' })).findReferences('symbol')).toEqual([]);
    const controller = new AbortController(); controller.abort(new Error('cancelled'));
    const invoke = vi.fn();
    await expect(lookup(invoke, controller.signal).findReferences('symbol')).rejects.toThrow('cancelled');
    expect(invoke).not.toHaveBeenCalled();
  });
});
