/**
 * Summarizer failures must not kill a run. A persistent failure ends in the
 * mechanical cut inside the same Compacting visit; it never goes through the
 * provider-error path (Recovering), so it spends no per-turn transient retry
 * budget and adds no pre-emit passes. Only a context the cut cannot shrink
 * still ends in `compact_exhausted`.
 */
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import type { ChatProvider, ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import type { ChatDelta } from '@mcp/provider-sdk';
import { runBehaviorTree, buildDefaultNodes } from '../orchestrator.js';
import { CompactingNode } from '../nodes/compacting.js';
import type { BehaviorNode, RunContext } from '../machine/types.js';
import { makeTestContext } from '../nodes/__tests__/test-helpers.js';

class TextOnlyProvider implements ChatProvider {
  readonly name = 'stub';
  model = 'stub-1';
  calls = 0;
  setModel(m: string) { this.model = m; }
  async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
    this.calls++;
    yield { type: 'text_delta', text: 'done' };
    yield { type: 'usage', usage: { input_tokens: 50, output_tokens: 1 } };
    yield { type: 'done' };
  }
}

function harness(messages: AgentMessage[]) {
  const provider = new TextOnlyProvider();
  const { ctx } = makeTestContext({
    provider,
    registry: new ToolRegistry(),
    toolContext: { cwd: process.cwd(), projectName: 'test' } as ToolContext,
  });
  const events: Array<{ event: string; args: unknown[] }> = [];
  const emit = ((event: string, ...args: unknown[]) => { events.push({ event, args }); }) as RunContext['emit'];
  const nodes = buildDefaultNodes();
  let summarizeCalls = 0;
  nodes.Compacting = new CompactingNode({
    protectTokensOverride: 2_000,
    maxTailTokensOverride: 4_000,
    summarizeOverride: async () => { summarizeCalls++; return null; },
  });
  const transientAfterCompaction: number[] = [];
  nodes.Reviewing = {
    state: 'Reviewing',
    execute: async (runCtx) => {
      transientAfterCompaction.push(runCtx.transientRetriesThisTurn + runCtx.transportRetriesThisTurn);
      return { kind: 'TurnSucceeded', hasToolCalls: false };
    },
  } as BehaviorNode;
  const realRecovering = nodes.Recovering;
  let recoveringVisits = 0;
  nodes.Recovering = {
    state: 'Recovering',
    execute: async (runCtx, last) => { recoveringVisits++; return realRecovering.execute(runCtx, last); },
  } as BehaviorNode;
  const run = () => runBehaviorTree({ opts: ctx.opts, emit, initialTiers: null, initialMessages: messages }, nodes);
  return { run, provider, events, stats: () => ({ summarizeCalls, recoveringVisits, transientAfterCompaction }) };
}

describe('compaction failure path', () => {
  it('a summarizer that always fails ends in a mechanical cut and the run finishes', async () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push({ role: 'user', content: [{ type: 'text', text: `u${i} ${'x'.repeat(60_000)}` }] });
      messages.push({ role: 'assistant', content: [{ type: 'text', text: `a${i} ${'y'.repeat(60_000)}` }] });
    }
    messages.push({ role: 'user', content: [{ type: 'text', text: 'finish the task' }] });
    const h = harness(messages);

    const result = await h.run();

    expect(result.reason).not.toBe('compact_exhausted');
    expect(result.reason).not.toBe('compact_failure');
    expect(h.provider.calls).toBe(1);
    const strategies = h.events
      .filter((e) => e.event === 'history_compacted')
      .map((e) => (e.args[0] as { strategy: string }).strategy);
    expect(strategies).toContain('deterministic');
    // Compaction failures never reach the provider-error path, so the per-turn
    // transient retry budget is untouched.
    expect(h.stats().recoveringVisits).toBe(0);
  });

  it('does not spend the per-turn transient retry budget on a failed summary', async () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push({ role: 'user', content: [{ type: 'text', text: `u${i} ${'x'.repeat(60_000)}` }] });
      messages.push({ role: 'assistant', content: [{ type: 'text', text: `a${i} ${'y'.repeat(60_000)}` }] });
    }
    messages.push({ role: 'user', content: [{ type: 'text', text: 'finish the task' }] });
    const h = harness(messages);

    await h.run();

    // Exactly one compaction, finished with the budget untouched.
    expect(h.stats().transientAfterCompaction).toEqual([0]);
    expect(h.stats().summarizeCalls).toBe(2);
  });

  it('a context the mechanical cut cannot shrink still ends in compact_exhausted, without Recovering', async () => {
    // A final turn that alone exceeds the window. The cutoff lands past it, so
    // neither the summarizer nor the mechanical cut can shrink anything: the
    // pre-emit gate keeps firing until its cap, exactly as before.
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push({ role: 'user', content: [{ type: 'text', text: `u${i} ${'x'.repeat(20_000)}` }] });
      messages.push({ role: 'assistant', content: [{ type: 'text', text: `a${i} ${'y'.repeat(20_000)}` }] });
    }
    messages.push({ role: 'user', content: [{ type: 'text', text: 'z'.repeat(2_000_000) }] });
    const h = harness(messages);

    const result = await h.run();

    expect(result.reason).toBe('compact_exhausted');
    expect(h.provider.calls).toBe(0);
    expect(h.stats().recoveringVisits).toBe(0);
  });
});
