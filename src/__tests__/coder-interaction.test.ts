import { describe, it, expect } from 'vitest';
import {
  CoderRunner,
  compactHistoryForLLM,
  buildToolResultBlock,
  normalizeMessageForCache,
  normalizeMessagesForCache,
} from '@mcp/code-agent/core/runner.js';
import type { AgentMessage } from "@mcp/provider-sdk";
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { planTools } from '@mcp/code-agent/tools/plan.js';
import { interactionTools } from '@mcp/code-agent/tools/interaction.js';
import type { ChatProvider, ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import type { ChatDelta } from "@mcp/provider-sdk";

class StubProvider implements ChatProvider {
  readonly name = 'stub';
  model = 'stub-1';
  setModel(m: string) { this.model = m; }
  async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
    yield { type: 'done' };
  }
}

function makeRunner(planMode = false) {
  const registry = new ToolRegistry();
  registry.registerAll(planTools);
  registry.registerAll(interactionTools);
  return new CoderRunner({
    provider: new StubProvider(),
    registry,
    systemPrompt: 'test',
    toolContext: { cwd: '/tmp', projectName: 'test' },
    planMode,
  });
}

describe('runner interactive primitives', () => {
  it('waitForUserInput resolves when provideUserInput is called', async () => {
    const r = makeRunner();
    const p = r.waitForUserInput();
    expect(r.provideUserInput('hello')).toBe(true);
    expect(await p).toBe('hello');
  });

  it('provideUserInput returns false when nothing is pending', () => {
    const r = makeRunner();
    expect(r.provideUserInput('x')).toBe(false);
  });

  it('approvePlan toggles isPlanApproved', () => {
    const r = makeRunner(true);
    expect(r.isPlanApproved()).toBe(false);
    r.approvePlan();
    expect(r.isPlanApproved()).toBe(true);
  });

  it('swapProvider replaces provider and emits event', () => {
    const r = makeRunner();
    const newProv = new StubProvider();
    newProv.setModel('stub-2');
    let seen: string | null = null;
    r.on('provider_swapped', (_p, model) => { seen = model; });
    r.swapProvider(newProv);
    expect(r.provider.model).toBe('stub-2');
    expect(seen).toBe('stub-2');
  });

  it('submit_plan tool emits plan_posted and routes the response', async () => {
    const r = makeRunner(true);
    const tool = planTools.find((t) => t.name === 'submit_plan')!;
    const events: string[] = [];
    r.on('plan_posted', (b) => { events.push(b.plan); });

    const resultP = tool.handler({ plan: 'do X' }, { cwd: '/tmp', projectName: 'test', runner: r, planMode: true });
    // microtask flush
    await new Promise((res) => setTimeout(res, 0));
    expect(events).toEqual(['do X']);
    r.provideUserInput(JSON.stringify({ approved: true }));
    const result = await resultP;
    expect(result.isError).toBeUndefined();
    expect(result.content).toMatch(/approved/i);
    expect(r.isPlanApproved()).toBe(true);
  });

  it('ask_user tool emits question_posted and returns the answer', async () => {
    const r = makeRunner();
    const tool = interactionTools.find((t) => t.name === 'ask_user')!;
    let posted: string | null = null;
    r.on('question_posted', (b) => { posted = b.question; });

    const resultP = tool.handler(
      { question: 'A or B?', options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] },
      { cwd: '/tmp', projectName: 'test', runner: r },
    );
    await new Promise((res) => setTimeout(res, 0));
    expect(posted).toBe('A or B?');
    r.provideUserInput(JSON.stringify({ answer: 'a' }));
    const result = await resultP;
    expect(result.content).toContain('a');
  });
});

function buildSyntheticHistory(opts: { toolTurns: number; toolResultSize: number }): AgentMessage[] {
  const msgs: AgentMessage[] = [];
  msgs.push({ role: 'user', content: [{ type: 'text', text: 'do everything' }] });
  const big = 'x'.repeat(opts.toolResultSize);
  for (let i = 0; i < opts.toolTurns; i++) {
    msgs.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: `t${i}`, name: 'mcp__read_file', input: { path: `f${i}.ts` } }],
    });
    msgs.push({
      role: 'tool',
      content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: big }],
    });
  }
  return msgs;
}

describe('buildToolResultBlock — push-time monotone truncation', () => {
  it('leaves small content intact', () => {
    const b = buildToolResultBlock('id1', 'small output', false);
    expect(b.content).toBe('small output');
    expect(b.truncated).toBeUndefined();
  });

  it('truncates content above PUSH_TIME_CAP with a deterministic marker', () => {
    const big = 'x'.repeat(30_000);
    const b = buildToolResultBlock('id1', big, false);
    expect(b.truncated).toBe(true);
    expect(b.originalSize).toBe(30_000);
    expect(b.content).toContain('[truncated: original_size=30000');
  });

  it('produces the same content for the same input across calls (cache-stable)', () => {
    // This is the key invariant: a block created at turn N must be byte-identical
    // to a block created at turn N+5 with the same raw content. Otherwise the
    // server-side prefix cache (ZAI auto-cache, Anthropic ephemeral) misses.
    const big = 'x'.repeat(15_000);
    const a = buildToolResultBlock('id1', big, false);
    const b = buildToolResultBlock('id1', big, false);
    expect(a.content).toBe(b.content);
  });
});

describe('compactHistoryForLLM — pass-through (legacy compat)', () => {
  it('does not compact messages below the threshold (content equivalent, input not mutated)', () => {
    // The per-turn view never prunes tool_result content (only the LLM compactor does).
    const msgs = buildSyntheticHistory({ toolTurns: 6, toolResultSize: 5000 });
    const snapshot = JSON.stringify(msgs);
    const out = compactHistoryForLLM(msgs);
    // Input must not be mutated
    expect(JSON.stringify(msgs)).toBe(snapshot);
    // No tool_result should be replaced with a [compacted:] marker
    for (const m of out) {
      for (const b of m.content) {
        if (b.type === 'tool_result' && typeof b.content === 'string') {
          expect(b.content).not.toMatch(/^\[compacted:/);
        }
      }
    }
  });
});

describe('normalizeMessageForCache — legacy resume normalization', () => {
  it('truncates legacy uncapped tool_result blocks on session resume', () => {
    const big = 'y'.repeat(30_000);
    const legacy: AgentMessage = {
      role: 'tool',
      content: [{ type: 'tool_result', tool_use_id: 'old', content: big }],
    };
    const normalized = normalizeMessageForCache(legacy);
    const block = normalized.content[0];
    if (block.type !== 'tool_result') throw new Error('expected tool_result');
    expect(block.truncated).toBe(true);
    expect(block.originalSize).toBe(30_000);
  });

  it('is idempotent — second normalization does not change a truncated block', () => {
    const big = 'z'.repeat(30_000);
    const legacy: AgentMessage = {
      role: 'tool',
      content: [{ type: 'tool_result', tool_use_id: 'old', content: big }],
    };
    const once = normalizeMessageForCache(legacy);
    const twice = normalizeMessageForCache(once);
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
  });

  it('keeps selected specialist outputs authoritative but never unbounded on resume', () => {
    const big = 's'.repeat(30_000);
    const history: AgentMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'spec-call', name: 'app_get_spec', input: {} }],
      },
      {
        role: 'tool',
        content: [{ type: 'tool_result', tool_use_id: 'spec-call', content: big }],
      },
    ];
    const normalized = normalizeMessagesForCache(history, 24_000, new Set(['app_get_spec']));
    const block = normalized[1].content[0];
    if (block.type !== 'tool_result') throw new Error('expected tool_result');
    expect(block.truncated).toBe(true);
    expect(block.originalSize).toBe(big.length);
    expect(block.content.length).toBeLessThanOrEqual(24_000);
    expect(block.content).toContain('original_size=30000');
  });
});
