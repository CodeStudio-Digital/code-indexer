import { describe, it, expect } from 'vitest';
import {
  computeCutoffIndexByTokens,
  snapCutoffPreservingPairs,
  compactMessages,
  postCompactCleanup,
  deriveTokenLimits,
  shouldCompact,
} from '../core/coder/core/compaction.js';
import { computeSnapshot } from '../core/coder/core/token-accounting.js';
import type { AgentMessage, ContentBlock } from '../core/coder/core/messages.js';

const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const toolUse = (id: string, name: string, input: Record<string, unknown> = {}): ContentBlock =>
  ({ type: 'tool_use', id, name, input });
const toolResult = (id: string, content: string): ContentBlock =>
  ({ type: 'tool_result', tool_use_id: id, content });
const assistant = (...blocks: ContentBlock[]): AgentMessage => ({ role: 'assistant', content: blocks });
const user = (...blocks: ContentBlock[]): AgentMessage => ({ role: 'user', content: blocks });
const tool = (...blocks: ContentBlock[]): AgentMessage => ({ role: 'tool', content: blocks });

/**
 * Inspect the messages and return the set of orphans:
 *   - tool_use ids without a matching tool_result anywhere in messages
 *   - tool_result ids without a matching tool_use anywhere in messages
 */
function findOrphans(messages: AgentMessage[]): { uses: string[]; results: string[] } {
  const uses = new Set<string>();
  const results = new Set<string>();
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'tool_use') uses.add((b as { id: string }).id);
      else if (b.type === 'tool_result') {
        const id = (b as { tool_use_id?: string }).tool_use_id;
        if (id) results.add(id);
      }
    }
  }
  return {
    uses: [...uses].filter((u) => !results.has(u)),
    results: [...results].filter((r) => !uses.has(r)),
  };
}

describe('compaction — atomicity (no orphan tool_use ⇄ tool_result after cutoff)', () => {
  it('snapCutoffPreservingPairs recedes cutoff to keep a split pair together', () => {
    // Pair (id=A) is split: tool_use is in msg 1 (assistant), tool_result is in msg 2 (tool).
    // If cutoff lands at index 2, that orphans the tool_use (it survives in msg 1 prefix
    // but its result is gone). Snap should recede to 1.
    const msgs: AgentMessage[] = [
      user(text('go')),                        // 0
      assistant(toolUse('A', 'read', { path: 'a.ts' })), // 1
      tool(toolResult('A', 'file content')),   // 2
      assistant(text('done')),                  // 3
    ];
    expect(snapCutoffPreservingPairs(msgs, 2)).toBe(1);
  });

  it('snapCutoffPreservingPairs preserves a pair entirely on the keep side', () => {
    const msgs: AgentMessage[] = [
      assistant(toolUse('A', 'read'), toolUse('B', 'write')),
      tool(toolResult('A', 'a'), toolResult('B', 'b')),
      user(text('next')),
    ];
    // Cutoff at 0 means keep everything — no work to do.
    expect(snapCutoffPreservingPairs(msgs, 0)).toBe(0);
  });

  it('compactMessages with token cutoff never produces orphans', () => {
    // Build a 30-message conversation with paired tool calls scattered throughout.
    const msgs: AgentMessage[] = [];
    for (let i = 0; i < 15; i++) {
      msgs.push(user(text(`turn-${i} request`.repeat(50))));
      msgs.push(assistant(toolUse(`id${i}`, 'read_file', { path: `f${i}.ts` })));
      msgs.push(tool(toolResult(`id${i}`, `content of f${i} `.repeat(80))));
    }
    // Keep ~30% as protected tail.
    const protectTokens = 1500;
    const result = compactMessages(msgs, { protectTokens, skipMinimumGuard: true });
    expect(result.applied).toBe(true);
    const orphans = findOrphans(result.messages);
    expect(orphans.uses).toEqual([]);
    expect(orphans.results).toEqual([]);
  });

  it('compactMessages preserves tool_use IDs in the kept tail', () => {
    const msgs: AgentMessage[] = [];
    for (let i = 0; i < 10; i++) {
      msgs.push(user(text(`req${i}`.repeat(40))));
      msgs.push(assistant(toolUse(`id${i}`, 'read_file', { path: `f${i}.ts` })));
      msgs.push(tool(toolResult(`id${i}`, `data${i}`.repeat(100))));
    }
    const result = compactMessages(msgs, { protectTokens: 800, skipMinimumGuard: true });
    // Every surviving tool_result should have its tool_use also surviving.
    const orphans = findOrphans(result.messages);
    expect(orphans).toEqual({ uses: [], results: [] });
  });

  it('returns applied=false when protected tail covers everything', () => {
    const msgs: AgentMessage[] = [user(text('hi')), assistant(text('hello'))];
    const r = compactMessages(msgs, { protectTokens: 99999, skipMinimumGuard: true });
    expect(r.applied).toBe(false);
  });
});

describe('compaction — token limits scale with model context window', () => {
  it('Claude 200K: trigger ≈ 200K − 20K output − 13K buffer', () => {
    const limits = deriveTokenLimits('claude-opus-4-7');
    expect(limits.rawWindow).toBe(200_000);
    expect(limits.effective).toBe(200_000 - 20_000); // output capped at 20K
    expect(limits.trigger).toBe(200_000 - 20_000 - 13_000);
    expect(limits.isFallback).toBe(false);
  });

  it('DeepSeek 1M: trigger ≈ 1M − 20K − 13K (much higher than Claude)', () => {
    const limits = deriveTokenLimits('deepseek-v4-flash');
    expect(limits.rawWindow).toBe(1_000_000);
    expect(limits.trigger).toBeGreaterThan(900_000);
  });

  it('unknown model: falls back to 128K with isFallback=true', () => {
    const limits = deriveTokenLimits('totally-fake-model-xyz');
    expect(limits.isFallback).toBe(true);
    expect(limits.rawWindow).toBe(128_000);
  });

  it('shouldCompact: returns false when total below trigger', () => {
    const messages: AgentMessage[] = [user(text('hi'))];
    const snap = computeSnapshot(messages, null);
    expect(shouldCompact(snap, 'claude-opus-4-7')).toBe(false);
  });

  it('shouldCompact: returns true when total ≥ trigger', () => {
    const messages: AgentMessage[] = [user(text('hi'))];
    const snap = computeSnapshot(messages, { input_tokens: 999_999, messageCountAtTime: 1 });
    expect(shouldCompact(snap, 'claude-opus-4-7')).toBe(true);
  });
});

describe('compaction — postCompactCleanup', () => {
  it('elides duplicate reads of the same path/slice', () => {
    const msgs: AgentMessage[] = [
      assistant(toolUse('id1', 'read_file', { path: 'a.ts' })),
      tool(toolResult('id1', 'first read of a.ts'.repeat(50))),
      user(text('again please')),
      assistant(toolUse('id2', 'read_file', { path: 'a.ts' })),
      tool(toolResult('id2', 'second read of a.ts'.repeat(50))),
    ];
    const r = postCompactCleanup(msgs);
    expect(r.elidedReads).toBe(1);
    expect(r.freedChars).toBeGreaterThan(0);
    // The first (older) result was elided; the second survives verbatim.
    const firstToolMsg = r.messages[1];
    const firstResult = firstToolMsg.content[0] as { content: string };
    expect(firstResult.content).toMatch(/duplicate-read elided/);
  });

  it('keeps reads of different paths intact', () => {
    const msgs: AgentMessage[] = [
      assistant(toolUse('id1', 'read_file', { path: 'a.ts' })),
      tool(toolResult('id1', 'a contents')),
      assistant(toolUse('id2', 'read_file', { path: 'b.ts' })),
      tool(toolResult('id2', 'b contents')),
    ];
    const r = postCompactCleanup(msgs);
    expect(r.elidedReads).toBe(0);
  });

  it('is idempotent (running twice does not double-elide)', () => {
    const msgs: AgentMessage[] = [
      assistant(toolUse('id1', 'read_file', { path: 'a.ts' })),
      tool(toolResult('id1', 'first read'.repeat(50))),
      assistant(toolUse('id2', 'read_file', { path: 'a.ts' })),
      tool(toolResult('id2', 'second read'.repeat(50))),
    ];
    const r1 = postCompactCleanup(msgs);
    const r2 = postCompactCleanup(r1.messages);
    expect(r2.elidedReads).toBe(0);
  });
});
