/**
 * Local top-K rerank — only the head moves, ties keep producer order, and an
 * agreeing rerank leaves entries byte-untouched. Minimal fake ITextModel.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type * as MonacoNs from 'monaco-editor';
import {
  rerankCompletionEntries,
  __resetLocalRerankForTests,
  RERANK_TOP_K,
} from '../lsp/local-rerank.js';

function fakeModel(lines: string[], uri = 'file:///p/1/a.ts', version = 1): MonacoNs.editor.ITextModel {
  const text = lines.join('\n');
  return {
    uri: { toString: () => uri },
    getVersionId: () => version,
    getLineContent: (n: number) => lines[n - 1] ?? '',
    getPositionAt: (offset: number) => {
      let remaining = Math.min(offset, text.length);
      for (let i = 0; i < lines.length; i++) {
        if (remaining <= lines[i]!.length) return { lineNumber: i + 1, column: remaining + 1 };
        remaining -= lines[i]!.length + 1; // + newline
      }
      return { lineNumber: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1 };
    },
    getValueInRange: () => text,
  } as unknown as MonacoNs.editor.ITextModel;
}

const pos = (lineNumber: number, column: number) => ({ lineNumber, column }) as MonacoNs.Position;

beforeEach(() => __resetLocalRerankForTests());

describe('rerankCompletionEntries', () => {
  it('boosts the exact typed-prefix match into first place via sortText', () => {
    const model = fakeModel(['const x = con']);
    const entries = [
      { label: 'window', sortText: '11' },
      { label: 'console', sortText: '12' },
      { label: 'const', sortText: '13' },
      { label: 'document', sortText: '14' },
      { label: 'alert', sortText: '15' },
      { label: 'tail', sortText: '16' },
    ];
    const out = rerankCompletionEntries(entries, model, pos(1, 14)); // after 'con'
    // Prefix matches float up; their sortText now sorts before every producer key.
    expect(out[0]!.label === 'console' || out[0]!.label === 'const').toBe(true);
    expect(out[0]!.sortText!.charCodeAt(0)).toBeLessThan('0'.charCodeAt(0));
    // Beyond top-K the producer order and sortText are untouched.
    expect(out[RERANK_TOP_K]).toEqual({ label: 'tail', sortText: '16' });
  });

  it('n-gram locality breaks ties between equally-prefixed candidates', () => {
    const model = fakeModel(['client.connect();', 'client.co']);
    const entries = [
      { label: 'count', sortText: '11' },
      { label: 'connect', sortText: '12' },
      { label: 'copy', sortText: '13' },
    ];
    const out = rerankCompletionEntries(entries, model, pos(2, 10)); // after 'client.co'
    expect(out[0]!.label).toBe('connect'); // seen after `client` in the buffer
  });

  it('leaves entries untouched when local signals agree with the producer', () => {
    const model = fakeModel(['fresh line ']);
    const entries = [
      { label: 'alpha', sortText: '11' },
      { label: 'beta', sortText: '12' },
      { label: 'gamma', sortText: '13' },
    ];
    const out = rerankCompletionEntries(entries, model, pos(1, 12));
    expect(out).toEqual([
      { label: 'alpha', sortText: '11' },
      { label: 'beta', sortText: '12' },
      { label: 'gamma', sortText: '13' },
    ]);
  });

  it('short lists pass through unmodified', () => {
    const model = fakeModel(['x']);
    const entries = [{ label: 'a', sortText: '1' }, { label: 'b', sortText: '2' }];
    expect(rerankCompletionEntries(entries, model, pos(1, 2))).toBe(entries);
  });
});
