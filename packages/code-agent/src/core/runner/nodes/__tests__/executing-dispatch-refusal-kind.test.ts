/**
 * `refusalKind` tagging — every harness-synthesized refusal path in
 * `dispatchTools` must stamp its kind on the DispatchedToolResult so
 * telemetry (coder_tool_calls.refusal_kind) can separate guard
 * interventions from genuine tool failures. Before this, only dedup was
 * distinguishable and per-tool error rates counted refusals as failures.
 */
import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';
import type { FailureStreakState } from '../../guards/failure-streak.js';
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

function baseArgs(registry: ToolRegistry, overrides?: Partial<DispatchArgs>): DispatchArgs {
  return {
    toolUses: [{ id: 'tu1', name: 'some_tool', input: { a: 1 } }],
    registry,
    toolContext: { cwd: process.cwd(), projectName: 'refusal-kind-test' } as ToolContext,
    turn: 1,
    ...overrides,
  };
}

describe('dispatchTools — refusalKind tagging per synthesis path', () => {
  it("toolGate refusal → 'gate'", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('some_tool'));
    const r = await dispatchTools(baseArgs(registry, {
      toolGate: () => '[plan-mode: mutating tool blocked]',
    }));
    expect(r.results[0].isError).toBe(true);
    expect(r.results[0].refusalKind).toBe('gate');
  });

  it('awaits an asynchronous toolGate before invoking the handler', async () => {
    const registry = new ToolRegistry();
    let invoked = false;
    registry.register(makeTool('some_tool', {
      handler: async () => {
        invoked = true;
        return { content: 'should not execute' };
      },
    }));
    const r = await dispatchTools(baseArgs(registry, {
      toolGate: async () => '[goal-verifier: completion rejected]',
    }));

    expect(invoked).toBe(false);
    expect(r.results[0]).toMatchObject({
      isError: true,
      refusalKind: 'gate',
      content: '[goal-verifier: completion rejected]',
    });
  });

  it('toolGate refusals happen before tuple-hash dedup accounting', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('some_tool'));
    const r = await dispatchTools(baseArgs(registry, {
      toolGate: () => '[agent-decision-guardrail: blocked]',
      toolUses: [
        { id: 't1', name: 'some_tool', input: { a: 1 } },
        { id: 't2', name: 'some_tool', input: { a: 1 } },
        { id: 't3', name: 'some_tool', input: { a: 1 } },
      ],
    }));
    expect(r.results).toHaveLength(3);
    expect(r.results.every((x) => x.refusalKind === 'gate')).toBe(true);
  });

  it("ignores obsolete pre-read hard refusals; a non-error pointer stays a reuse", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('some_tool'));

    const allowed = await dispatchTools(baseArgs(registry, {
      enforcePreRead: () => 'Refused: `read_file` already read this slice.',
    }));
    expect(allowed.results[0].isError).toBe(false);
    expect(allowed.results[0].content).toBe('ok');

    const downgraded = await dispatchTools(baseArgs(registry, {
      enforcePreRead: () => ({ content: '[skeleton pointer to prior read]', isError: false }),
    }));
    expect(downgraded.results[0].isError).toBe(false);
    expect(downgraded.results[0].refusalKind).toBeUndefined();
    expect(downgraded.results[0].guardVerdict?.action).toBe('reuse');
  });

  it("enforceTaskMode refusal → 'task-mode'", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('some_tool', { mutates: true }));
    const r = await dispatchTools(baseArgs(registry, {
      enforceTaskMode: () => '[task-mode: mutations go through execute_tasks]',
    }));
    expect(r.results[0].refusalKind).toBe('task-mode');
  });

  it('repeated authorized mutations are not tagged as refusals', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('some_tool', { mutates: true, executionClass: 'write' }));
    const r = await dispatchTools(baseArgs(registry, {
      toolUses: [
        { id: 't1', name: 'some_tool', input: { a: 1 } },
        { id: 't2', name: 'some_tool', input: { a: 1 } },
        { id: 't3', name: 'some_tool', input: { a: 1 } },
      ],
    }));
    expect(r.results[0].refusalKind).toBeUndefined();
    expect(r.results[1].refusalKind).toBeUndefined(); // reminder still delivers content
    expect(r.results[2].isError).toBe(false);
    expect(r.results[2].refusalKind).toBeUndefined();
  });

  it("permission-gate denial → 'user_denied' (matches classifyToolRefusal's tag)", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('some_tool'));
    const args = baseArgs(registry);
    args.toolContext = {
      ...args.toolContext,
      permissionGate: {
        check: async () => ({ allowed: false as const, refusalText: '[user-denied: nope]' }),
        pendingCount: () => 0,
      } as unknown as ToolContext['permissionGate'],
    };
    const r = await dispatchTools(args);
    expect(r.results[0].isError).toBe(true);
    expect(r.results[0].refusalKind).toBe('user_denied');
  });

  it('preserves the original error after the failure observation threshold', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('some_tool', {
      handler: async () => ({ content: 'boom', isError: true }),
    }));
    // Pre-seed four consecutive failures: this call is the 5th, which is the
    // default CODER_FAILURE_STREAK_REFUSE threshold → refuse.
    const failureStreakState: FailureStreakState = {
      streaks: new Map([
        ['some_tool', { consecutive: 4, firstFailureTurn: 1, lastFailureTurn: 4, lastError: 'boom' }],
      ]),
    };
    const r = await dispatchTools(baseArgs(registry, { failureStreakState, turn: 5 }));
    expect(r.results[0].isError).toBe(true);
    expect(r.results[0].content).toBe('boom');
    expect(r.results[0].refusalKind).toBeUndefined();
  });

  it('unchanged successful polls remain successful without entering failure streak', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('some_tool', { repeatPolicy: 'pollable' }));
    const failureStreakState: FailureStreakState = { streaks: new Map() };
    const r = await dispatchTools(baseArgs(registry, {
      failureStreakState,
      detectPollingStuck: () => 'Refused: unchanged poll result.',
    }));

    expect(r.results[0]).toMatchObject({
      isError: false,
      content: 'ok',
      guardVerdict: {
        action: 'shadow',
        reason: 'polling-stuck',
        affectsFailureStreak: false,
      },
    });
    expect(failureStreakState.streaks.size).toBe(0);
  });

  it("per-tool timeout → 'timeout'", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('some_tool', {
      timeoutMs: 50,
      handler: () => new Promise(() => {}), // hangs
    }));
    const r = await dispatchTools(baseArgs(registry));
    expect(r.results[0].isError).toBe(true);
    expect(r.results[0].content).toContain('[tool-timeout:');
    expect(r.results[0].refusalKind).toBe('timeout');
  });

  it("session abort → 'abort'", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('some_tool', {
      handler: () => new Promise(() => {}), // hangs until aborted
    }));
    const controller = new AbortController();
    const args = baseArgs(registry);
    args.toolContext = { ...args.toolContext, signal: controller.signal };
    const pending = dispatchTools(args);
    controller.abort();
    const r = await pending;
    expect(r.results[0].isError).toBe(true);
    expect(r.results[0].content).toContain('[tool-aborted:');
    expect(r.results[0].refusalKind).toBe('abort');
  });

  it('a real invocation (success OR handler error) stays untagged', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('ok_tool'));
    registry.register(makeTool('err_tool', {
      handler: async () => ({ content: 'real failure', isError: true }),
    }));
    const r = await dispatchTools(baseArgs(registry, {
      toolUses: [
        { id: 'a', name: 'ok_tool', input: {} },
        { id: 'b', name: 'err_tool', input: {} },
      ],
    }));
    expect(r.results[0].isError).toBe(false);
    expect(r.results[0].refusalKind).toBeUndefined();
    expect(r.results[1].isError).toBe(true);
    expect(r.results[1].refusalKind).toBeUndefined(); // genuine failure ≠ refusal
  });
});
