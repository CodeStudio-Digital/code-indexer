/**
 * Orchestrator hardening tests.
 *
 *   - Fix 1: a node that throws must NOT reject `runBehaviorTree`. The throw
 *     is converted to `Aborted` so the loop exits to `Done`, the terminal
 *     `done` event still fires (reason='error' + the captured error), and a
 *     `RunResult` is returned. Without this the SSE/dashboard stays stuck in
 *     "streaming…" because `ctx.emit('done')` lives after the try/finally.
 *
 *   - Fix 3: repeated pre-emit compaction is bounded. The pre-emit gate
 *     decrements `turn`, so `maxTurns` can't backstop a compaction that never
 *     frees the window. After the fixed cap (3) of consecutive pre-emit
 *     routings the run aborts with `stopReason='compact_exhausted'` instead of
 *     looping forever.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { runBehaviorTree, buildDefaultNodes } from '../orchestrator.js';
import type { BehaviorNode, RunContext } from '../machine/types.js';
import { makeTestContext } from '../nodes/__tests__/test-helpers.js';

function recordingEmit(): { events: Array<{ event: string; args: unknown[] }>; emit: RunContext['emit'] } {
  const events: Array<{ event: string; args: unknown[] }> = [];
  const emit = ((event: string, ...args: unknown[]) => {
    events.push({ event, args });
  }) as RunContext['emit'];
  return { events, emit };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('runBehaviorTree — Fix 1 (node throw → done, never reject)', () => {
  it('converts a node throw into a clean done(reason="error") + RunResult', async () => {
    const { ctx } = makeTestContext();
    const { events, emit } = recordingEmit();
    const boom = new Error('node exploded');
    const nodes = buildDefaultNodes();
    nodes.Bootstrap = {
      state: 'Bootstrap',
      execute: async () => {
        throw boom;
      },
    } as BehaviorNode;

    // The promise MUST resolve — a reject here means the throw escaped.
    const result = await runBehaviorTree(
      { opts: ctx.opts, emit, initialTiers: null },
      nodes,
    );

    expect(result.reason).toBe('error');

    const done = events.find((e) => e.event === 'done');
    expect(done).toBeDefined();
    expect(done!.args[0]).toBe('error'); // reason
    expect(done!.args[1]).toBe(boom); // captured error
  });

  it('honors a host abort requested while a node is in flight', async () => {
    const { ctx } = makeTestContext();
    const { events, emit } = recordingEmit();
    let abortRequested = false;
    const executeNext = vi.fn(async () => ({ kind: 'CleanFinish' as const }));
    const nodes = buildDefaultNodes();
    nodes.Bootstrap = {
      state: 'Bootstrap',
      execute: async () => {
        abortRequested = true;
        return { kind: 'TurnSucceeded', hasToolCalls: false };
      },
    } as BehaviorNode;
    nodes.Executing = {
      state: 'Executing',
      execute: executeNext,
    } as BehaviorNode;

    const result = await runBehaviorTree(
      {
        opts: ctx.opts,
        emit,
        initialTiers: null,
        bridge: { isAbortRequested: () => abortRequested },
      },
      nodes,
    );

    expect(result.reason).toBe('aborted');
    expect(executeNext).not.toHaveBeenCalled();
    expect(events.find((e) => e.event === 'done')?.args[0]).toBe('aborted');
  });
});

describe('runBehaviorTree — Fix 3 (pre-emit compaction is bounded)', () => {
  it('aborts with compact_exhausted after the fixed cap of consecutive pre-emit compactions', async () => {
    const { ctx } = makeTestContext({
      registry: new ToolRegistry(),
      // A real cwd so `buildTools`' tool-filter hook lookup (join(cwd, …))
      // doesn't throw before we reach the pre-emit gate.
      toolContext: { cwd: process.cwd(), projectName: 'test' } as ToolContext,
    });
    const { events, emit } = recordingEmit();

    // History large enough that shouldCompactPreEmit always fires (ratio
    // far above 0.9) regardless of the model's effective window.
    const huge = 'x'.repeat(2_000_000);
    const hugeMessages: AgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text: huge }] },
      { role: 'assistant', content: [{ type: 'text', text: huge }] },
    ];

    // Real Bootstrap + real Executing (the node under test). Mock Compacting
    // and Reviewing so the loop drives straight back into Executing each
    // cycle: Executing →(TokenThresholdHit)→ Compacting →(CompactionDone)→
    // Reviewing →(TurnSucceeded)→ Executing → …
    const nodes = buildDefaultNodes();
    nodes.Compacting = {
      state: 'Compacting',
      execute: async () => ({ kind: 'CompactionDone', collapsedFrom: 1, collapsedTo: 1 }),
    } as BehaviorNode;
    nodes.Reviewing = {
      state: 'Reviewing',
      execute: async () => ({ kind: 'TurnSucceeded', hasToolCalls: false }),
    } as BehaviorNode;

    const result = await runBehaviorTree(
      { opts: ctx.opts, emit, initialTiers: null, initialMessages: hugeMessages },
      nodes,
    );

    expect(result.reason).toBe('compact_exhausted');

    const done = events.find((e) => e.event === 'done');
    expect(done).toBeDefined();
    expect(done!.args[0]).toBe('compact_exhausted');

    // cap=2 → fires on the 1st and 2nd pre-emit, aborts on the 3rd.
    const thresholdHits = events.filter((e) => e.event === 'turn_start');
    expect(thresholdHits.length).toBeGreaterThanOrEqual(2);
  });
});
