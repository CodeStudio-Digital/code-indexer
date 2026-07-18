/**
 * Hidden-call pin mechanism (`dispatchTools`).
 *
 * A registered tool can be absent from the model's visible list (tier-hidden
 * or cap-cut) yet called by name — find_tools tells the model to do exactly
 * that. Contract:
 *   - hidden + registered → executes, result gains the deterministic
 *     `[toolset]` suffix, `onToolPinned` fires (once per batch — the live
 *     pin set makes the second call non-hidden)
 *   - admin/session-disabled → hard refusal (`gate`), handler NEVER runs,
 *     never pinned (closes the historical disabled-tools-execute hole)
 *   - goal-gated create_goal → refusal redirecting to update_goal
 *   - visible tool → untouched
 *   - CODER_TOOL_PIN_DISABLE=1 → all of the above off (legacy behavior)
 */
import { describe, it, expect, afterEach } from 'vitest';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';
import type { DupCallEntry } from '../../machine/types.js';
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

function pinArgs(registry: ToolRegistry, overrides?: Partial<DispatchArgs>): DispatchArgs & { _pins: Set<string> } {
  const pins = new Set<string>();
  return {
    toolUses: [{ id: 'tu1', name: 'hidden_tool', input: { a: 1 } }],
    registry,
    toolContext: { cwd: process.cwd(), projectName: 'pin-test' } as ToolContext,
    turn: 1,
    dupCalls: new Map<string, DupCallEntry>(),
    visibleToolNames: new Set(['visible_tool']),
    pinnedTools: pins,
    onToolPinned: (n) => pins.add(n),
    _pins: pins,
    ...overrides,
  };
}

afterEach(() => {
  delete process.env.CODER_TOOL_PIN_DISABLE;
});

describe('dispatchTools — hidden-call pin', () => {
  it('hidden registered tool executes, gains the [toolset] suffix, and pins', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('hidden_tool'));
    const args = pinArgs(registry);
    const r = await dispatchTools(args);
    expect(r.results[0].isError).toBe(false);
    expect(r.results[0].content).toContain('ok');
    expect(r.results[0].content).toContain("[toolset] 'hidden_tool'");
    expect(args._pins.has('hidden_tool')).toBe(true);
  });

  it('second call in the same batch gets no duplicate suffix (live pin set)', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('hidden_tool'));
    const args = pinArgs(registry, {
      toolUses: [
        { id: 't1', name: 'hidden_tool', input: { a: 1 } },
        { id: 't2', name: 'hidden_tool', input: { a: 2 } },
      ],
    });
    const r = await dispatchTools(args);
    expect(r.results[0].content).toContain('[toolset]');
    expect(r.results[1].content).not.toContain('[toolset]');
  });

  it('never lets the pin suffix exceed the finalizer inline cap', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('hidden_tool', { handler: async () => ({ content: 'x'.repeat(100) }) }));
    const args = pinArgs(registry, {
      finalizeToolResult: () => ({ content: 'x'.repeat(20), inlineCap: 20 }),
    });
    const r = await dispatchTools(args);
    expect(r.results[0].content).toHaveLength(20);
    expect(args._pins.has('hidden_tool')).toBe(true);
  });

  it('disabled tool is hard-blocked: handler never runs, not pinned, refusalKind gate', async () => {
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
    expect(args._pins.size).toBe(0);
  });

  it('goal-gated create_goal refuses with redirection instead of pinning', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('create_goal'));
    const args = pinArgs(registry, {
      toolUses: [{ id: 't1', name: 'create_goal', input: {} }],
      toolContext: {
        cwd: process.cwd(),
        projectName: 'pin-test',
        getGoalState: () => ({ text: 'existing goal', status: 'in_progress' }),
      } as unknown as ToolContext,
    });
    const r = await dispatchTools(args);
    expect(r.results[0].isError).toBe(true);
    expect(r.results[0].refusalKind).toBe('gate');
    expect(r.results[0].content).toContain('update_goal');
    expect(args._pins.size).toBe(0);
  });

  it('hidden create_goal with NO active goal executes and pins (cap-cut case)', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('create_goal'));
    const args = pinArgs(registry, {
      toolUses: [{ id: 't1', name: 'create_goal', input: {} }],
    });
    const r = await dispatchTools(args);
    expect(r.results[0].isError).toBe(false);
    expect(args._pins.has('create_goal')).toBe(true);
  });

  it('visible tool result is untouched and never pinned', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('visible_tool'));
    const args = pinArgs(registry, {
      toolUses: [{ id: 't1', name: 'visible_tool', input: {} }],
    });
    const r = await dispatchTools(args);
    expect(r.results[0].content).not.toContain('[toolset]');
    expect(args._pins.size).toBe(0);
  });

  it('pins even when the tool errors (intent is clear; stops repeat suffixes)', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('hidden_tool', {
      handler: async () => ({ content: 'boom', isError: true }),
    }));
    const args = pinArgs(registry);
    const r = await dispatchTools(args);
    expect(r.results[0].isError).toBe(true);
    expect(r.results[0].content).toContain('[toolset]');
    expect(args._pins.has('hidden_tool')).toBe(true);
  });

  it('CODER_TOOL_PIN_DISABLE=1 restores legacy behavior (no suffix, no pin, no block)', async () => {
    process.env.CODER_TOOL_PIN_DISABLE = '1';
    const registry = new ToolRegistry();
    registry.register(makeTool('hidden_tool'));
    const args = pinArgs(registry, {
      isToolBlocked: () => '[tool-disabled] nope',
    });
    const r = await dispatchTools(args);
    expect(r.results[0].isError).toBe(false);
    expect(r.results[0].content).not.toContain('[toolset]');
    expect(args._pins.size).toBe(0);
  });
});
