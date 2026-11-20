import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import { compactHistoryForLLM } from '../compact-history.js';

function bigHistory(turns: number, resultChars: number): AgentMessage[] {
  const out: AgentMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'start' }] }];
  for (let i = 0; i < turns; i++) {
    out.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'read_file', input: { path: `f${i}.ts` } }] });
    out.push({ role: 'tool', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'x'.repeat(resultChars) }] });
  }
  return out;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('compactHistoryForLLM — per-turn view', () => {
  it('does not warn about payload size: a typical history exceeds any fixed char budget every turn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const messages = bigHistory(12, 20_000);
    const out = compactHistoryForLLM(messages);
    expect(out.length).toBe(messages.length);
    expect(warn).not.toHaveBeenCalled();
  });
});
