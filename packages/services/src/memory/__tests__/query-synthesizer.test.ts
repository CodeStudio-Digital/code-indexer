import { describe, it, expect } from 'vitest';
import { parseQuery, LlmMemoryQuerySynthesizer, type ConversationTail } from '../query-synthesizer.js';
import type { PipelineProviderResolver } from '../../pipelines/index.js';

const tail: ConversationTail = [
  { role: 'user', text: 'implement OAuth refresh flow' },
  { role: 'assistant', text: 'added refresh handler' },
  { role: 'user', text: 'continue' },
];

describe('parseQuery', () => {
  it('takes the first non-empty line', () => {
    expect(parseQuery('OAuth refresh flow implementation')).toBe('OAuth refresh flow implementation');
    expect(parseQuery('\n\nOAuth token refresh\nextra noise')).toBe('OAuth token refresh');
  });
  it('strips think-tags and code fences', () => {
    expect(parseQuery('<think>hmm</think>\nauth refresh')).toBe('auth refresh');
    expect(parseQuery('```\nauth refresh\n```')).toBe('auth refresh');
  });
  it('strips an UNCLOSED/truncated think block (reasoning model cut off)', () => {
    // No closing tag → must not leak the reasoning dump as the query.
    expect(parseQuery('<think>analyzing the conversation to figure out the task')).toBeNull();
    expect(parseQuery('<think>reasoning...\nmore reasoning without a close')).toBeNull();
    // A closed think block followed by a real answer still yields the answer.
    expect(parseQuery('<think>done thinking</think>\nsession cache invalidation')).toBe('session cache invalidation');
  });
  it('drops a leading label and surrounding quotes', () => {
    expect(parseQuery('Query: "auth refresh flow"')).toBe('auth refresh flow');
    expect(parseQuery('`session cache bug`')).toBe('session cache bug');
  });
  it('returns null for empty output', () => {
    expect(parseQuery('')).toBeNull();
    expect(parseQuery('   \n  ')).toBeNull();
    expect(parseQuery('<think>only thinking</think>')).toBeNull();
  });
  it('caps length at 200 chars', () => {
    expect(parseQuery('x'.repeat(400))!.length).toBe(200);
  });
});

describe('LlmMemoryQuerySynthesizer.synthesize — fail-open to null', () => {
  it('returns null when skipLlm', async () => {
    const s = new LlmMemoryQuerySynthesizer({ resolver: {} as PipelineProviderResolver, skipLlm: true });
    expect(await s.synthesize(tail)).toBeNull();
  });
  it('returns null for an empty tail (never calls the resolver)', async () => {
    const resolver = {
      resolveChain: async () => { throw new Error('must not be called'); },
    } as unknown as PipelineProviderResolver;
    expect(await new LlmMemoryQuerySynthesizer({ resolver }).synthesize([])).toBeNull();
  });
  it('returns null when no binding resolves (unconfigured → heuristic)', async () => {
    const resolver = { resolveChain: async () => [] } as unknown as PipelineProviderResolver;
    expect(await new LlmMemoryQuerySynthesizer({ resolver }).synthesize(tail)).toBeNull();
  });
  it('returns null when the resolver throws', async () => {
    const resolver = {
      resolveChain: async () => { throw new Error('down'); },
    } as unknown as PipelineProviderResolver;
    expect(await new LlmMemoryQuerySynthesizer({ resolver }).synthesize(tail)).toBeNull();
  });
});
