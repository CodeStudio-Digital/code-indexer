import { describe, it, expect } from 'vitest';
import { computePrefixHeadHash } from '@mcp/code-agent/core/runner/telemetry/prefix-head.js';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';

const msg = (role: 'user' | 'assistant', text: string): AgentMessage => ({
  role,
  content: [{ type: 'text', text }],
});

describe('computePrefixHeadHash', () => {
  it('is stable for the same head', () => {
    const a = [msg('user', 'oi'), msg('assistant', 'olá'), msg('user', 'segue')];
    expect(computePrefixHeadHash(a)).toBe(computePrefixHeadHash([...a]));
  });

  it('changes when an early message mutates in place', () => {
    const base = [msg('user', 'oi'), msg('assistant', 'olá'), msg('user', 'segue')];
    const mutated = [msg('user', 'oi'), msg('assistant', '[duplicate-read elided]'), msg('user', 'segue')];
    expect(computePrefixHeadHash(base)).not.toBe(computePrefixHeadHash(mutated));
  });

  it('does NOT change when the tail grows (normal turn appends)', () => {
    const head = [msg('user', 'oi'), msg('assistant', 'olá'), msg('user', 'segue')];
    const grown = [...head, msg('assistant', 'turno 2'), msg('user', 'mais'), msg('assistant', 'turno 3')];
    expect(computePrefixHeadHash(grown)).toBe(computePrefixHeadHash(head));
  });

  it('returns null for an empty history and never throws on odd content', () => {
    expect(computePrefixHeadHash([])).toBeNull();
    const weird = [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(10_000) }] } as AgentMessage];
    expect(typeof computePrefixHeadHash(weird)).toBe('string');
  });
});
