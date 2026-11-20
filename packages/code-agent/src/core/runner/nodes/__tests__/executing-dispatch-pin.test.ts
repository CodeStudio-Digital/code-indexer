/**
 * Hidden authorized calls (`dispatchTools`).
 *
 * A registered tool can be absent from the model's visible list yet called by
 * name — find_tools tells the model to do exactly that. Contract (the runtime
 * pin window was removed; the stable catalog never changes mid-run):
 *   - hidden + registered → executes; the result text claims no catalog change
 *   - admin/session-disabled → hard refusal (`gate`), handler NEVER runs
 *     (closes the historical disabled-tools-execute hole)
 *   - visible tool → untouched; hard blocks always win
 */
import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';
import { dispatchTools, type DispatchArgs } from '../executing-dispatch.js';

function makeTool(name: string, opts?: Partial<CoderTool>): CoderTool {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: {} },
    source: 'native',
    handler: async () => ({ content: 'ok' }),
    ...opts,
  };
}

function pinArgs(registry: ToolRegistry, overrides?: Partial<DispatchArgs>): DispatchArgs {
  return {
    toolUses: [{ id: 'tu1', name: 'hidden_tool', input: { a: 1 } }],
    registry,
    toolContext: { cwd: process.cwd(), projectName: 'pin-test' } as ToolContext,
    turn: 1,
    visibleToolNames: new Set(['visible_tool']),
    ...overrides,
  };
}

describe('dispatchTools — hidden authorized calls', () => {
  it('hidden registered tool executes without claiming a catalog change', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('hidden_tool'));
    const args = pinArgs(registry);
    const r = await dispatchTools(args);
    expect(r.results[0].isError).toBe(false);
    expect(r.results[0].content).toBe('ok');
    expect(r.results[0].content).not.toContain('[toolset');
    expect(r.results[0].content).not.toContain('pinned');
  });

  it('leaves the finalized content of a hidden call unchanged', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('hidden_tool', { handler: async () => ({ content: 'x'.repeat(100) }) }));
    const args = pinArgs(registry, {
      finalizeToolResult: () => ({ content: 'x'.repeat(20), inlineCap: 60 }),
    });
    const r = await dispatchTools(args);
    expect(r.results[0].content).toBe('x'.repeat(20));
  });

  it('disabled tool is hard-blocked: handler never runs, refusalKind gate', async () => {
    const registry = new ToolRegistry();
    let ran = false;
    registry.register(makeTool('hidden_tool', { handler: async () => { ran = true; return { content: 'ok' }; } }));
    const args = pinArgs(registry, {
      isToolBlocked: (n) => (n === 'hidden_tool' ? '[tool-disabled] nope' : null),
    });
    const r = await dispatchTools(args);
    expect(ran).toBe(false);
    expect(r.results[0].isError).toBe(true);
    expect(r.results[0].refusalKind).toBe('gate');
    expect(r.results[0].content).toContain('[tool-disabled]');
  });

  it('visible tool result is untouched', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('visible_tool'));
    const args = pinArgs(registry, {
      toolUses: [{ id: 't1', name: 'visible_tool', input: {} }],
    });
    const r = await dispatchTools(args);
    expect(r.results[0].content).not.toContain('[toolset]');
  });

  it('returns a hidden tool error unchanged', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('hidden_tool', {
      handler: async () => ({ content: 'boom', isError: true }),
    }));
    const args = pinArgs(registry);
    const r = await dispatchTools(args);
    expect(r.results[0].isError).toBe(true);
    expect(r.results[0].content).toBe('boom');
  });

  it('preserves hard blocks for hidden tools', async () => {
    const registry = new ToolRegistry();
    let ran = false;
    registry.register(makeTool('hidden_tool', {
      handler: async () => {
        ran = true;
        return { content: 'ok' };
      },
    }));
    const args = pinArgs(registry, {
      isToolBlocked: () => '[tool-disabled] nope',
    });
    const r = await dispatchTools(args);
    expect(r.results[0].isError).toBe(true);
    expect(r.results[0].content).toContain('[tool-disabled]');
    expect(r.results[0].content).not.toContain('[toolset]');
    expect(ran).toBe(false);
  });

  it('preserves nested capability hard blocks', async () => {
    const registry = new ToolRegistry();
    const hidden = makeTool('hidden_tool');
    registry.register(hidden);
    registry.register(makeTool('code_exec', {
      handler: async (_input, ctx) => {
        const refusal = await ctx.nestedCapabilityDispatch?.preflight?.({
          tool: hidden,
          toolUseId: 'nested-1',
          toolName: hidden.name,
          toolInput: {},
          toolMutates: false,
          turn: 1,
        });
        return { content: refusal?.content ?? 'not blocked' };
      },
    }));
    const args = pinArgs(registry, {
      toolUses: [{ id: 'parent-1', name: 'code_exec', input: {} }],
      visibleToolNames: new Set(['code_exec']),
      isToolBlocked: (name) =>
        name === 'hidden_tool' ? '[tool-disabled] nested nope' : null,
    });

    const result = await dispatchTools(args);
    expect(result.results[0].isError).toBe(false);
    expect(result.results[0].content).toContain('[tool-disabled] nested nope');
  });
});
