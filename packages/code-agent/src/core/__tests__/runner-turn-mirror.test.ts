/**
 * Regression: the public `CoderRunner.turn` mirror must track the
 * loop-local `RunContext.turn` (incremented by the Executing node).
 *
 * The bug: the docstring on `CoderRunner.turn` promised a mirror, but no
 * code ever wrote it — it stayed frozen at 0 for the whole run, so every
 * turn-accounting consumer read a dead 0.
 *
 * The fix intercepts `turn_start` in the BT emit bridge
 * (runViaBehaviorTree) and assigns `this.turn` BEFORE forwarding to
 * listeners.
 *
 * The live consumer is the snapshot/checkpoint path in index.ts
 * (`checkpointCoordinator.submit(checkpoint, runner.turn)`).
 */
import { describe, expect, it } from 'vitest';
import { CoderRunner } from '@mcp/code-agent/core/runner.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { ChatProvider, ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import type { ChatDelta } from '@mcp/code-agent/core/messages.js';

class StubProvider implements ChatProvider {
  readonly name = 'stub';
  model = 'stub-1';
  setModel(m: string) { this.model = m; }
  async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
    yield { type: 'text_delta', text: 'final answer, no tool calls' };
    yield { type: 'done' };
  }
}

function makeRunner() {
  return new CoderRunner({
    provider: new StubProvider(),
    registry: new ToolRegistry(),
    systemPrompt: 'test',
    toolContext: { cwd: '/tmp', projectName: 'test' },
  });
}

describe('CoderRunner.turn mirror (turn_start)', () => {
  it('uses the admitted runner identity in behavior-tree lifecycle events', async () => {
    const runner = makeRunner();
    const ids: string[] = [];
    runner.on('run_started', event => ids.push(event.runId));
    runner.on('provider_call', event => ids.push(event.runId));
    runner.pushUserMessage('hello');
    await runner.run();
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(new Set(ids)).toEqual(new Set([runner.runId]));
  });
  it('starts at 0 and tracks each turn_start before listeners observe it', async () => {
    const runner = makeRunner();
    expect(runner.turn).toBe(0);

    // The mirror must be updated BEFORE the event reaches listeners —
    // listeners (flushPendingTurn, SnapshotRecorder, …) read `runner.turn`.
    const seen: Array<{ arg: number; mirror: number }> = [];
    runner.on('turn_start', (t) => seen.push({ arg: t, mirror: runner.turn }));

    runner.pushUserMessage('hello');
    await runner.run();

    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(s.mirror).toBe(s.arg);
    // Single-turn run: the mirror ends at 1, not frozen at 0.
    expect(runner.turn).toBe(1);
  });
});
