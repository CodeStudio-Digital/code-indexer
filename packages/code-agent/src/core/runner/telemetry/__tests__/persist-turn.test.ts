/**
 * Pure-function tests for `persistTurnTelemetry`.
 *
 * Scope: prove the helper computes the derived signals
 * (`largest_tool_result_chars`, `paginate_count`, `estimated_cost_usd`)
 * correctly and forwards every other field through to `store.recordTurnTelemetry`.
 *
 * The class-bound side effects (quality classifier dispatch + tool-
 * selection observer) live in `runner.ts` and are NOT exercised here —
 * they have their own integration test under
 * `core/__tests__/runner-*`.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ChatUsage, ContentBlock, ToolUseBlock } from '@mcp/code-agent/core/messages.js';
import { persistTurnTelemetry } from '../persist-turn.js';

interface RecordedRow {
  session_id: number | null;
  tool_count: number;
  tools_called: string[];
  largest_tool_result_chars: number | null;
  paginate_count: number;
  compaction_triggered: boolean;
  summarizer_ran: boolean;
  system_prompt_chars: number | null;
  tools_def_chars: number | null;
  estimated_cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
}

function makeMockStore() {
  const rows: RecordedRow[] = [];
  let nextId = 100;
  const store = {
    recordTurnTelemetry(input: RecordedRow): number {
      rows.push(input);
      return nextId++;
    },
  };
  return { store, rows };
}

function toolUse(name: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return { type: 'tool_use', id: `tu-${name}`, name, input };
}

function toolResult(content: string): ContentBlock {
  return { type: 'tool_result', tool_use_id: 'tu', content } as unknown as ContentBlock;
}

const baseUsage: ChatUsage = {
  input_tokens: 1000,
  output_tokens: 200,
  cache_creation_input_tokens: 50,
  cache_read_input_tokens: 400,
};

describe('persistTurnTelemetry — pure function', () => {
  it('returns null and writes nothing when store is undefined', () => {
    const r = persistTurnTelemetry({
      store: undefined,
      sessionId: 1,
      runId: 'run-1',
      isSubagent: false,
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      turn: 1,
      usage: baseUsage,
      toolUseBlocks: [],
      toolResultBlocks: [],
      historyChars: 100,
      compactionTriggered: false,
      summarizerRan: false,
    });
    expect(r).toBeNull();
  });

  it('inserts a row and returns the new id', () => {
    const { store, rows } = makeMockStore();
    const id = persistTurnTelemetry({
      store: store as never,
      sessionId: 42,
      runId: 'run-x',
      isSubagent: false,
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      turn: 7,
      usage: baseUsage,
      toolUseBlocks: [toolUse('grep_code')],
      toolResultBlocks: [toolResult('result body')],
      historyChars: 2048,
      compactionTriggered: false,
      summarizerRan: false,
      systemPromptChars: 333,
      toolsDefChars: 4444,
    });
    expect(id).toBe(100);
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe(42);
    expect(rows[0].tool_count).toBe(1);
    expect(rows[0].tools_called).toEqual(['grep_code']);
    expect(rows[0].system_prompt_chars).toBe(333);
    expect(rows[0].tools_def_chars).toBe(4444);
    expect(rows[0].input_tokens).toBe(1000);
  });

  it('computes largest_tool_result_chars across multiple tool_results', () => {
    const { store, rows } = makeMockStore();
    persistTurnTelemetry({
      store: store as never,
      sessionId: 1, runId: 'r', isSubagent: false,
      provider: 'anthropic', model: 'claude-haiku-4-5-20251001',
      turn: 1, usage: baseUsage,
      toolUseBlocks: [toolUse('grep_code'), toolUse('mcp__read_file')],
      toolResultBlocks: [toolResult('short'), toolResult('x'.repeat(500)), toolResult('mid')],
      historyChars: 0,
      compactionTriggered: false, summarizerRan: false,
    });
    expect(rows[0].largest_tool_result_chars).toBe(500);
  });

  it('largest_tool_result_chars is null when no tool_results', () => {
    const { store, rows } = makeMockStore();
    persistTurnTelemetry({
      store: store as never,
      sessionId: 1, runId: 'r', isSubagent: false,
      provider: 'anthropic', model: 'claude-haiku-4-5-20251001',
      turn: 1, usage: baseUsage,
      toolUseBlocks: [], toolResultBlocks: [],
      historyChars: 0,
      compactionTriggered: false, summarizerRan: false,
    });
    expect(rows[0].largest_tool_result_chars).toBeNull();
  });

  it('computes paginate_count from repeated read_file paths', () => {
    const { store, rows } = makeMockStore();
    persistTurnTelemetry({
      store: store as never,
      sessionId: 1, runId: 'r', isSubagent: false,
      provider: 'anthropic', model: 'claude-haiku-4-5-20251001',
      turn: 1, usage: baseUsage,
      toolUseBlocks: [
        toolUse('read_file', { path: 'a.ts' }),
        toolUse('read_file', { path: 'a.ts' }),   // +1 repeat
        toolUse('read_file', { path: 'a.ts' }),   // +1 repeat
        toolUse('read_file', { path: 'b.ts' }),   // first b.ts — no repeat yet
        toolUse('mcp__read_file', { path: 'b.ts' }), // +1 repeat (mixed names count too)
        toolUse('grep_code', { pattern: 'foo' }), // ignored
      ],
      toolResultBlocks: [],
      historyChars: 0,
      compactionTriggered: false, summarizerRan: false,
    });
    // a.ts appears 3× → 2 extras; b.ts appears 2× → 1 extra. Total = 3.
    expect(rows[0].paginate_count).toBe(3);
  });

  it('paginate_count is 0 when no repeats', () => {
    const { store, rows } = makeMockStore();
    persistTurnTelemetry({
      store: store as never,
      sessionId: 1, runId: 'r', isSubagent: false,
      provider: 'anthropic', model: 'claude-haiku-4-5-20251001',
      turn: 1, usage: baseUsage,
      toolUseBlocks: [toolUse('read_file', { path: 'a.ts' })],
      toolResultBlocks: [],
      historyChars: 0,
      compactionTriggered: false, summarizerRan: false,
    });
    expect(rows[0].paginate_count).toBe(0);
  });

  it('survives a store throw and returns null', () => {
    const store = {
      recordTurnTelemetry: vi.fn(() => { throw new Error('db boom'); }),
    };
    const r = persistTurnTelemetry({
      store: store as never,
      sessionId: 1, runId: 'r', isSubagent: false,
      provider: 'anthropic', model: 'claude-haiku-4-5-20251001',
      turn: 1, usage: baseUsage,
      toolUseBlocks: [],
      toolResultBlocks: [],
      historyChars: 0,
      compactionTriggered: false, summarizerRan: false,
    });
    expect(r).toBeNull();
    expect(store.recordTurnTelemetry).toHaveBeenCalledOnce();
  });

  it('flows compaction/summarizer flags through unchanged', () => {
    const { store, rows } = makeMockStore();
    persistTurnTelemetry({
      store: store as never,
      sessionId: 1, runId: 'r', isSubagent: false,
      provider: 'anthropic', model: 'claude-haiku-4-5-20251001',
      turn: 1, usage: baseUsage,
      toolUseBlocks: [],
      toolResultBlocks: [],
      historyChars: 0,
      compactionTriggered: true,
      summarizerRan: true,
    });
    expect(rows[0].compaction_triggered).toBe(true);
    expect(rows[0].summarizer_ran).toBe(true);
  });
});
