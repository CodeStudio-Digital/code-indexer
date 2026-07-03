import { describe, expect, it } from 'vitest';
import type { FileDiff } from '../session-snapshots.js';
import {
  MAX_CONTEXT_CHARS,
  MAX_FOCUS_CHARS,
  MAX_INTENT_CHARS,
  MAX_SYMBOL_LINES,
  buildEnclosingSymbolContext,
  formatReviewContext,
} from '../snapshot-review-context.js';

interface HunkSpec {
  newStart: number;
  newLines: number;
  anchorLine?: number;
  decision?: 'pending' | 'kept' | 'reverted';
}

function makeDiff(filePath: string, content: string | null, hunks: HunkSpec[]): FileDiff {
  return {
    baseline: { id: 1, filePath, existedBefore: true, oversized: false, status: 'active' },
    diffDisabled: false,
    currentContent: content,
    hunks: hunks.map((h, i) => ({
      fingerprint: `fp${i}`,
      oldStart: h.newStart,
      oldLines: h.newLines,
      newStart: h.newStart,
      newLines: h.newLines,
      addedCount: 1,
      removedCount: 0,
      hiddenBefore: 0,
      hiddenAfter: 0,
      canExpandBefore: false,
      canExpandAfter: false,
      lines: [{ type: 'add' as const, newLine: h.anchorLine ?? h.newStart, content: 'x' }],
      decision: h.decision ?? 'pending',
    })),
  };
}

/** A brace-language function spanning lines 1..(bodyLines+2). Body lines are
 *  plain statements (no const/let) so findEnclosingDeclLine anchors on the
 *  `function` line, not on a declaration-looking body line. */
function tsFunction(name: string, bodyLines: number, lineWidth = 12): string {
  const body = Array.from({ length: bodyLines }, (_, i) => `  acc += ${i} + ${'9'.repeat(lineWidth)};`);
  return [`function ${name}() {`, ...body, '}'].join('\n');
}

describe('buildEnclosingSymbolContext', () => {
  it('extracts the enclosing function and dedups multiple hunks in the same symbol', () => {
    const content = tsFunction('alpha', 6); // lines 1..8
    const diff = makeDiff('src/a.ts', content, [
      { newStart: 2, newLines: 3, anchorLine: 3 },
      { newStart: 5, newLines: 2, anchorLine: 6 },
    ]);
    const out = buildEnclosingSymbolContext([diff]);
    expect(out).not.toBeNull();
    expect(out!.match(/enclosing symbol/g)).toHaveLength(1);
    expect(out).toContain('file=src/a.ts enclosing symbol lines 1-8:');
    expect(out).toContain('function alpha()');
  });

  it('skips a symbol already fully covered by the hunk window', () => {
    const content = tsFunction('tiny', 1); // lines 1..3
    const diff = makeDiff('src/b.ts', content, [{ newStart: 1, newLines: 5, anchorLine: 2 }]);
    expect(buildEnclosingSymbolContext([diff])).toBeNull();
  });

  it('truncates a symbol body beyond MAX_SYMBOL_LINES', () => {
    const content = tsFunction('huge', MAX_SYMBOL_LINES + 60);
    const diff = makeDiff('src/c.ts', content, [{ newStart: 5, newLines: 3, anchorLine: 6 }]);
    const out = buildEnclosingSymbolContext([diff])!;
    expect(out).toContain('... [symbol truncated]');
    // Header still reports the real range even though the body is cut.
    expect(out).toContain(`lines 1-${MAX_SYMBOL_LINES + 62}:`);
  });

  it('stops at the section budget and marks the omission', () => {
    // Each symbol renders ~13-14k chars; the second one crosses 24k.
    const big = (name: string) => tsFunction(name, 100, 120);
    const diffs = [
      makeDiff('src/d1.ts', big('first'), [{ newStart: 50, newLines: 3, anchorLine: 51 }]),
      makeDiff('src/d2.ts', big('second'), [{ newStart: 50, newLines: 3, anchorLine: 51 }]),
    ];
    const out = buildEnclosingSymbolContext(diffs)!;
    expect(out).toContain('function first()');
    expect(out).not.toContain('function second()');
    expect(out).toContain('... [more symbols omitted]');
  });

  it('skips deleted files, disabled diffs and non-pending hunks', () => {
    const gone = makeDiff('src/gone.ts', null, [{ newStart: 1, newLines: 2 }]);
    const disabled = makeDiff('src/bin.ts', tsFunction('bin', 3), [{ newStart: 1, newLines: 2 }]);
    disabled.diffDisabled = true;
    const decided = makeDiff('src/kept.ts', tsFunction('kept', 30), [
      { newStart: 3, newLines: 2, anchorLine: 4, decision: 'kept' },
      { newStart: 8, newLines: 2, anchorLine: 9, decision: 'reverted' },
    ]);
    expect(buildEnclosingSymbolContext([gone, disabled, decided])).toBeNull();
  });
});

describe('formatReviewContext', () => {
  it('returns null when every part is empty', () => {
    expect(formatReviewContext({})).toBeNull();
    expect(formatReviewContext({ focus: '  ', intent: null, symbols: '' })).toBeNull();
  });

  it('renders sections in order: task context, author focus, enclosing code', () => {
    const out = formatReviewContext({ focus: 'watch the retry', intent: 'fix the bug', symbols: 'file=x' })!;
    const iIntent = out.indexOf('## Task context');
    const iFocus = out.indexOf('## Author focus');
    const iSym = out.indexOf('## Enclosing code');
    expect(iIntent).toBeGreaterThanOrEqual(0);
    expect(iFocus).toBeGreaterThan(iIntent);
    expect(iSym).toBeGreaterThan(iFocus);
    expect(out).toContain('fix the bug');
    expect(out).toContain('watch the retry');
    expect(out).toContain('file=x');
  });

  it('caps focus, intent and the assembled text', () => {
    const out = formatReviewContext({
      focus: 'f'.repeat(MAX_FOCUS_CHARS * 2),
      intent: 'i'.repeat(MAX_INTENT_CHARS * 2),
      symbols: 's'.repeat(MAX_CONTEXT_CHARS * 2),
    })!;
    expect(out).toContain('... [truncated]');
    expect(out.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
  });
});
