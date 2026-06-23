import { describe, it, expect } from 'vitest';
import {
  estimateBlockTokens,
  estimateMessageTokens,
  computeSnapshot,
  __internal,
} from '@mcp/code-agent/core/token-accounting.js';
import type { AgentMessage, ContentBlock } from '@mcp/code-agent/core/messages.js';

const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const toolUse = (id: string, name: string, input: Record<string, unknown>): ContentBlock =>
  ({ type: 'tool_use', id, name, input });
const toolResult = (id: string, content: string): ContentBlock =>
  ({ type: 'tool_result', tool_use_id: id, content });
const assistant = (...blocks: ContentBlock[]): AgentMessage => ({ role: 'assistant', content: blocks });
const user = (...blocks: ContentBlock[]): AgentMessage => ({ role: 'user', content: blocks });
const tool = (...blocks: ContentBlock[]): AgentMessage => ({ role: 'tool', content: blocks });

describe('token-accounting — block estimates', () => {
  it('text block: chars/4 for prose, plus per-block overhead', () => {
    const block = text('hello world hello world hello world hello world hello world');
    // 60 chars / 4 = 15 + 8 overhead = 23
    expect(estimateBlockTokens(block)).toBe(23);
  });

  it('text block: detects JSON-dense text and uses chars/2', () => {
    const dense = '{"a":1,"b":2,"c":3,"d":4,"e":5,"f":6,"g":7,"h":8,"i":9,"j":10}';
    expect(__internal.isDenseText(dense)).toBe(true);
    const tokens = estimateBlockTokens(text(dense));
    // 62 chars / 2 = 31 + 8 = 39 (vs 24 if treated as plain text)
    expect(tokens).toBeGreaterThan(35);
  });

  it('tool_use block: serializes input and adds per-block overhead', () => {
    const block = toolUse('id1', 'read_file', { path: 'src/foo.ts' });
    const t = estimateBlockTokens(block);
    expect(t).toBeGreaterThan(8);
  });

  it('tool_result block: scales with content length', () => {
    const small = estimateBlockTokens(toolResult('id1', 'short'));
    const big = estimateBlockTokens(toolResult('id1', 'x'.repeat(4000)));
    expect(big).toBeGreaterThan(small * 50);
  });

  it('image block: fixed conservative overhead', () => {
    const t = estimateBlockTokens({ type: 'image', mediaType: 'image/png', base64: 'AAAA' });
    expect(t).toBe(8 + 1000);
  });
});

describe('token-accounting — computeSnapshot', () => {
  it('falls back to estimate-only when no usage available', () => {
    const messages: AgentMessage[] = [
      user(text('hi')),
      assistant(text('hello!')),
    ];
    const snap = computeSnapshot(messages, null);
    expect(snap.source).toBe('estimate');
    expect(snap.confirmed).toBe(0);
    expect(snap.pendingEstimate).toBeGreaterThan(0);
    expect(snap.total).toBe(snap.pendingEstimate);
  });

  it('uses API number when usage covers the full prefix', () => {
    const messages: AgentMessage[] = [
      user(text('hi')),
      assistant(text('hello')),
    ];
    // The API reported 100 input_tokens after seeing all 2 messages.
    const snap = computeSnapshot(messages, { input_tokens: 100, messageCountAtTime: 2 });
    expect(snap.source).toBe('api');
    expect(snap.confirmed).toBe(100);
    expect(snap.pendingEstimate).toBe(0);
    expect(snap.total).toBe(100);
  });

  it('mixes API number with tail estimate when new messages were appended after', () => {
    const messages: AgentMessage[] = [
      user(text('hi')),
      assistant(text('hello')),
      user(text('y'.repeat(100))), // appended after API call
    ];
    const snap = computeSnapshot(messages, { input_tokens: 100, messageCountAtTime: 2 });
    expect(snap.source).toBe('mixed');
    expect(snap.confirmed).toBe(100);
    expect(snap.pendingEstimate).toBeGreaterThan(0);
    expect(snap.total).toBe(100 + snap.pendingEstimate);
    expect(snap.estimatedMessages).toBe(1);
  });

  it('falls back to pure estimate when usage messageCountAtTime exceeds messages.length', () => {
    // (Defensive: caller sent stale usage from a longer prior history.)
    const messages: AgentMessage[] = [user(text('hi'))];
    const snap = computeSnapshot(messages, { input_tokens: 999, messageCountAtTime: 99 });
    expect(snap.source).toBe('estimate');
    expect(snap.confirmed).toBe(0);
  });
});

describe('token-accounting — estimateMessageTokens', () => {
  it('sums all block estimates in a message', () => {
    const m = assistant(text('hi'), toolUse('id1', 'foo', { x: 1 }));
    const sum = estimateMessageTokens(m);
    expect(sum).toBe(estimateBlockTokens(m.content[0]) + estimateBlockTokens(m.content[1]));
  });

  it('handles a tool message with multiple results', () => {
    const m = tool(toolResult('id1', 'a'.repeat(800)), toolResult('id2', 'b'.repeat(800)));
    expect(estimateMessageTokens(m)).toBeGreaterThan(300);
  });
});
