import { describe, expect, it } from 'vitest';
import { buildCommitDiffRows } from '../commit-file-diff.js';

describe('commit push diff rows', () => {
  it('keeps hunk metadata, line kinds and both gutter numbers', () => {
    const patch = [
      'diff --git a/example.ts b/example.ts',
      'index 1111111..2222222 100644',
      '--- a/example.ts',
      '+++ b/example.ts',
      '@@ -4,3 +4,3 @@',
      ' const stable = true;',
      '-const oldName = 1;',
      '+const newName = 2;',
      ' export { stable };',
      '',
    ].join('\n');

    const rows = buildCommitDiffRows(patch);
    expect(rows[0]).toMatchObject({ kind: 'hunk', content: '@@ -4,3 +4,3 @@' });
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'line', type: 'normal', oldLine: 4, newLine: 4 }),
      expect.objectContaining({ kind: 'line', type: 'delete', oldLine: 5, newLine: null, content: 'const oldName = 1;' }),
      expect.objectContaining({ kind: 'line', type: 'insert', oldLine: null, newLine: 5, content: 'const newName = 2;' }),
    ]));
  });

  it('falls back to a colored row model when a patch is cut mid-stream', () => {
    const rows = buildCommitDiffRows('@@ -1,1 +1,1 @@\n-old\n+new');
    expect(rows.map((row) => row.kind === 'line' ? row.type : row.kind)).toEqual(['hunk', 'delete', 'insert']);
  });
});
