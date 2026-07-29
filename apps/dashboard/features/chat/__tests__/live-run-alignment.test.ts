/**
 * The live buffer and the durable transcript describe the same assistant run
 * but disagree on block boundaries: the backend concatenates a round's
 * reasoning into ONE persisted block while the live coalescer opens a new one
 * at every tool boundary. These primitives make the comparison blind to that.
 */
import { describe, expect, it } from 'vitest';
import {
  normalizeRunText,
  normalizedCovers,
  normalizedDuplicated,
  persistedCoveragePrefixEnd,
  type CoverageContext,
} from '../live-run-alignment.js';
import type { StreamBlock } from '../../../hooks/useAgentStream.js';

const textBlock = (text: string): StreamBlock => ({ type: 'text', text });
const thinkingBlock = (text: string): StreamBlock => ({ type: 'thinking', text });
const toolBlock = (id: string): StreamBlock =>
  ({ type: 'tool', call: { id, name: 'read_file', input: {}, status: 'running' } }) as StreamBlock;
const activityBlock = (): StreamBlock =>
  ({ type: 'activity', id: 'act-1', kind: 'provider', status: 'running', startedAt: 0 }) as StreamBlock;

const ctx = (over: Partial<CoverageContext> = {}): CoverageContext => ({
  persistedTextNormalized: '',
  persistedThinkingNormalized: '',
  persistedIds: new Set<string>(),
  persistedSignatures: new Set<string>(),
  blockId: (b) => (b.type === 'tool' ? b.call.id : undefined),
  blockSignature: () => undefined,
  ...over,
});

describe('normalizeRunText', () => {
  it('erases the join separator and the synthetic ChatGPT part boundary', () => {
    // Live joins its blocks with '\n'; the backend concatenated them raw.
    expect(normalizeRunText('thinkA\nthinkB')).toBe(normalizeRunText('thinkAthinkB'));
    // chatgpt.ts injects '\n\n' between reasoning summary parts.
    expect(normalizeRunText('**Part one**\n\n**Part two**')).toBe('**Partone**\n\n**Parttwo**'.replace(/\s+/g, ''));
  });

  it('keeps genuinely different content different', () => {
    expect(normalizeRunText('think A')).not.toBe(normalizeRunText('think B'));
  });
});

describe('normalizedCovers', () => {
  it('is vacuously true when history has nothing to cover', () => {
    expect(normalizedCovers('', '', false)).toBe(true);
  });

  it('anchors at the start unless the window begins mid-turn', () => {
    expect(normalizedCovers('abcdef', 'abc', false)).toBe(true);
    expect(normalizedCovers('abcdef', 'cde', false)).toBe(false);
    expect(normalizedCovers('abcdef', 'cde', true)).toBe(true);
  });
});

describe('normalizedDuplicated', () => {
  it('is false for an empty live run and exact-matches outside a mid-turn window', () => {
    expect(normalizedDuplicated('abc', '', false)).toBe(false);
    expect(normalizedDuplicated('abc', 'abc', false)).toBe(true);
    expect(normalizedDuplicated('abcdef', 'def', false)).toBe(false);
    expect(normalizedDuplicated('abcdef', 'def', true)).toBe(true);
  });
});

describe('persistedCoveragePrefixEnd', () => {
  it('covers nothing when history is empty', () => {
    expect(persistedCoveragePrefixEnd([textBlock('hello')], ctx())).toBe(-1);
  });

  it('walks reasoning the backend concatenated across a tool boundary', () => {
    const blocks = [thinkingBlock('thinkA'), toolBlock('t1'), thinkingBlock('thinkB')];
    const prefixEnd = persistedCoveragePrefixEnd(blocks, ctx({
      persistedThinkingNormalized: normalizeRunText('thinkAthinkB'),
      persistedIds: new Set(['t1']),
    }));
    expect(prefixEnd).toBe(2);
  });

  it('stops at an identity history has never seen', () => {
    const blocks = [textBlock('done'), toolBlock('fresh'), textBlock('done')];
    const prefixEnd = persistedCoveragePrefixEnd(blocks, ctx({
      persistedTextNormalized: normalizeRunText('donedone'),
    }));
    expect(prefixEnd).toBe(0);
  });

  it('does not advance past a block that breaks the durable order', () => {
    const blocks = [textBlock('first'), textBlock('unexpected'), textBlock('second')];
    const prefixEnd = persistedCoveragePrefixEnd(blocks, ctx({
      persistedTextNormalized: normalizeRunText('firstsecond'),
    }));
    expect(prefixEnd).toBe(0);
  });

  it('passes through live-only telemetry without breaking the prefix', () => {
    const blocks = [textBlock('first'), activityBlock(), textBlock('second')];
    const prefixEnd = persistedCoveragePrefixEnd(blocks, ctx({
      persistedTextNormalized: normalizeRunText('first\nsecond'),
    }));
    expect(prefixEnd).toBe(2);
  });

  it('matches an interactive prompt by signature when its id is absent', () => {
    const blocks = [{ type: 'plan', plan: { id: 'p-new', plan: 'do x' } } as StreamBlock];
    const prefixEnd = persistedCoveragePrefixEnd(blocks, ctx({
      persistedSignatures: new Set(['plan-sig']),
      blockId: () => undefined,
      blockSignature: () => 'plan-sig',
    }));
    expect(prefixEnd).toBe(0);
  });
});
