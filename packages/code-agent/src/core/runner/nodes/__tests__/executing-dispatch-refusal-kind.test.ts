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
import type { DupCallEntry } from '../../machine/types.js';
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
    dupCalls: new Map<string, DupCallEntry>(),
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

  it('toolGate refusals happen before tuple-hash dedup accounting', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('some_tool'));
    const dupCalls = new Map<string, DupCallEntry>();
    const r = await dispatchTools(baseArgs(registry, {
      dupCalls,
      toolGate: () => '[agent-decision-guardrail: blocked]',
      toolUses: [
        { id: 't1', name: 'some_tool', input: { a: 1 } },
        { id: 't2', name: 'some_tool', input: { a: 1 } },
        { id: 't3', name: 'some_tool', input: { a: 1 } },
      ],
    }));
    expect(r.results).toHaveLength(3);
    expect(r.results.every((x) => x.refusalKind === 'gate')).toBe(true);
    expect(dupCalls.size).toBe(0);
    expect(r.toolLoopDetected).toBe(false);
  });

  it("hybrid ignores legacy pre-read hard refusal; legacy still tags it; pointer stays a reuse", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('some_tool'));

    const hybrid = await dispatchTools(baseArgs(registry, {
      enforcePreRead: () => 'Refused: `read_file` already read this slice.',
    }));
    expect(hybrid.results[0].isError).toBe(false);
    expect(hybrid.results[0].content).toBe('ok');

    const previous = process.env.CODER_DEDUP_POLICY;
    process.env.CODER_DEDUP_POLICY = 'legacy';
    try {
      const refused = await dispatchTools(baseArgs(registry, {
        enforcePreRead: () => 'Refused: `read_file` already read this slice.',
      }));
      expect(refused.results[0].isError).toBe(true);
      expect(refused.results[0].refusalKind).toBe('pre-read');
    } finally {
      if (previous === undefined) delete process.env.CODER_DEDUP_POLICY;
      else process.env.CODER_DEDUP_POLICY = previous;
    }

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

  it("tuple-hash dedup refusal → 'dedup' (and only on the refused call)", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('some_tool', { mutates: true, executionClass: 'write' }));
    const dupCalls = new Map<string, DupCallEntry>();
    const r = await dispatchTools(baseArgs(registry, {
      dupCalls,
      toolUses: [
        { id: 't1', name: 'some_tool', input: { a: 1 } },
        { id: 't2', name: 'some_tool', input: { a: 1 } },
        { id: 't3', name: 'some_tool', input: { a: 1 } },
      ],
    }));
    expect(r.results[0].refusalKind).toBeUndefined();
    expect(r.results[1].refusalKind).toBeUndefined(); // reminder still delivers content
    expect(r.results[2].isError).toBe(true);
    expect(r.results[2].refusalKind).toBe('dedup');
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

  it("failure-streak refuse → 'failure-streak' (replaces a real error at the threshold)", async () => {
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
    expect(r.results[0].refusalKind).toBe('failure-streak');
    expect(r.loopGuard).toBe('failure-streak');
  });

  it("unchanged poll result → 'polling-stuck' without entering failure streak", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('some_tool', { repeatPolicy: 'pollable' }));
    const failureStreakState: FailureStreakState = { streaks: new Map() };
    const r = await dispatchTools(baseArgs(registry, {
      failureStreakState,
      detectPollingStuck: () => 'Refused: unchanged poll result.',
    }));

    expect(r.results[0]).toMatchObject({
      isError: true,
      refusalKind: 'polling-stuck',
      guardVerdict: {
        action: 'block',
        reason: 'polling-stuck',
        affectsFailureStreak: false,
      },
    });
    expect(failureStreakState.streaks.size).toBe(0);
    expect(r.toolLoopDetected).toBe(false);
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
