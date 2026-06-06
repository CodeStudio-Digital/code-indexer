import { describe, it, expect } from 'vitest';
import { isReviewablePath, filterReviewableDiffs } from '../snapshot-review-ignore.js';

describe('isReviewablePath', () => {
  it('ignores .mcp-indexer paths (trash, worktrees, tool-outputs)', () => {
    expect(isReviewablePath('.mcp-indexer/trash/2024/foo.ts')).toBe(false);
    expect(isReviewablePath('.mcp-indexer/coder/tool-outputs/1/x.txt')).toBe(false);
    expect(isReviewablePath('.mcp-indexer/worktrees/feat/a.ts')).toBe(false);
  });

  it('ignores .git, node_modules and dist', () => {
    expect(isReviewablePath('node_modules/lib/index.js')).toBe(false);
    expect(isReviewablePath('.git/COMMIT_EDITMSG')).toBe(false);
    expect(isReviewablePath('dist/app.js')).toBe(false);
  });

  it('ignores an ignored segment nested anywhere in the path', () => {
    expect(isReviewablePath('packages/x/.mcp-indexer/trash/a.ts')).toBe(false);
  });

  it('keeps normal source paths', () => {
    expect(isReviewablePath('src/app/foo.ts')).toBe(true);
    expect(isReviewablePath('packages/services/src/x.ts')).toBe(true);
  });

  it('does not false-match similar (non-segment) names', () => {
    expect(isReviewablePath('src/mcp-indexer-helper.ts')).toBe(true);
    expect(isReviewablePath('src/distributed/x.ts')).toBe(true);
  });
});

describe('filterReviewableDiffs', () => {
  it('drops ignored diffs and keeps the rest in order', () => {
    const diffs = [
      { baseline: { filePath: 'src/a.ts' } },
      { baseline: { filePath: '.mcp-indexer/trash/b.ts' } },
      { baseline: { filePath: 'src/c.ts' } },
    ];
    expect(filterReviewableDiffs(diffs).map((d) => d.baseline.filePath)).toEqual([
      'src/a.ts',
      'src/c.ts',
    ]);
  });
});
