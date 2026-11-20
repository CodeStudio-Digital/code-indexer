/**
 * Fix 2 — bridge callbacks must never kill the turn.
 *
 * `reduceToolResult`, `postProcessToolResult` and `detectPollingStuck` are
 * best-effort shaping hooks owned by the host (`CoderRunner`). They run after
 * the tool invocation's try/finally; before the fix a throw in any of them
 * escaped `dispatchTools`, propagated to the orchestrator, and (pre Fix 1)
 * aborted the whole run. Now each is guarded and degrades to the pre-callback
 * value so the (already valid) tool_result still reaches the model.
 */
import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';
import { dispatchTools, type DispatchArgs } from '../executing-dispatch.js';

function registryWith(content: string): ToolRegistry {
  const r = new ToolRegistry();
  const tool: CoderTool = {
    name: 'foo',
    description: 'mock tool',
    parameters: { type: 'object', properties: {} },
    source: 'native',
    handler: async () => ({ content }),
  };
  r.register(tool);
  return r;
}

const toolContext = { cwd: process.cwd(), projectName: 'test' } as ToolContext;

function baseArgs(registry: ToolRegistry): DispatchArgs {
  return {
    toolUses: [{ id: 't1', name: 'foo', input: {} }],
    registry,
    toolContext,
    turn: 1,
  };
}

describe('dispatchTools — Fix 2 (guarded bridge callbacks)', () => {
  it('publishes a finished result before starting its slow sibling', async () => {
    const registry = registryWith('first');
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    registry.register({ name: 'slow', description: '', source: 'native',
      parameters: { type: 'object', properties: {} },
      handler: async () => { entered(); await blocked; return { content: 'second' }; },
    });
    const visible: string[] = [];
    const run = dispatchTools({ ...baseArgs(registry),
      toolUses: [{ id: 't1', name: 'foo', input: {} }, { id: 't2', name: 'slow', input: {} }],
      onToolResult: (result) => { visible.push(result.toolUseId); },
    });
    try {
      await started;
      expect(visible).toEqual(['t1']);
    } finally { release(); }
    const batch = await run;
    expect(visible).toEqual(['t1', 't2']);
    expect(batch.results.map((result) => result.toolUseId)).toEqual(visible);
  });

  it('does not retry an effect if its presentation observer throws', async () => {
    const res = await dispatchTools({ ...baseArgs(registryWith('done')),
      onToolResult: () => { throw new Error('disconnected UI'); },
    });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].content).toBe('done');
    expect(res.results[0].isError).toBe(false);
  });

  it('falls back to raw content when reduceToolResult throws', async () => {
    const res = await dispatchTools({
      ...baseArgs(registryWith('RAW')),
      reduceToolResult: () => {
        throw new Error('reduce boom');
      },
    });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].content).toBe('RAW');
    expect(res.results[0].isError).toBe(false);
  });

  it('skips post-processing when postProcessToolResult throws', async () => {
    const res = await dispatchTools({
      ...baseArgs(registryWith('RAW')),
      postProcessToolResult: () => {
        throw new Error('post boom');
      },
    });
    expect(res.results[0].content).toBe('RAW');
    expect(res.results[0].isError).toBe(false);
  });

  it('ignores detectPollingStuck when it throws (no false refusal)', async () => {
    const res = await dispatchTools({
      ...baseArgs(registryWith('RAW')),
      detectPollingStuck: () => {
        throw new Error('poll boom');
      },
    });
    expect(res.results[0].content).toBe('RAW');
    expect(res.results[0].isError).toBe(false);
  });

  it('still applies a well-behaved reducer (no regression)', async () => {
    const res = await dispatchTools({
      ...baseArgs(registryWith('RAW')),
      reduceToolResult: (_name, content) => `${content}-shaped`,
    });
    expect(res.results[0].content).toBe('RAW-shaped');
  });
});
