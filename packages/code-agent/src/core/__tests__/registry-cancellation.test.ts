import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../registry.js';
import type { CoderTool, ToolContext } from '../tool.js';

function fixture(source: CoderTool['source'] = 'native') {
  const handler = vi.fn(async () => ({ content: 'effect finished' }));
  const registry = new ToolRegistry();
  registry.register({ name: 'effect', description: 'fixture', source, mutates: true,
    parameters: { type: 'object', properties: {} }, handler });
  const abort = new AbortController();
  const ctx: ToolContext = { cwd: '.', projectName: 'fixture', signal: abort.signal };
  return { handler, registry, abort, ctx };
}

describe('tool dispatch cancellation boundary', () => {
  it.each(['native', 'mcp', 'mcp_external'] as const)('does not start a cancelled %s invocation', async source => {
    const f = fixture(source); f.abort.abort();
    const result = await f.registry.invoke('effect', {}, f.ctx);
    expect(f.handler).not.toHaveBeenCalled();
    expect(result).toMatchObject({ isError: true, error: { kind: 'cancelled', retryable: false },
      guardVerdict: { affectsFailureStreak: false, shouldReflect: false } });
  });

  it('preserves a confirmed result when cancellation arrives after the effect started', async () => {
    const f = fixture();
    f.handler.mockImplementationOnce(async () => { f.abort.abort(); return { content: 'effect finished' }; });
    await expect(f.registry.invoke('effect', {}, f.ctx)).resolves.toEqual({ content: 'effect finished' });
    expect(f.handler).toHaveBeenCalledOnce();
  });

  it('does not treat an IPC-cloned signal-shaped object as cancellation', async () => {
    const f = fixture(); f.ctx.signal = { aborted: true } as AbortSignal;
    await expect(f.registry.invoke('effect', {}, f.ctx)).resolves.toEqual({ content: 'effect finished' });
    expect(f.handler).toHaveBeenCalledOnce();
  });
});
