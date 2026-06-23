/**
 * Tests for the I2 Thunder-style hot source.
 *
 * Locks in:
 *   - Eviction behavior at maxSize
 *   - Edit-over-view kind upgrade
 *   - Project isolation in match()
 *   - Recency × tokenMatch scoring
 *   - Empty / short query edge cases
 */
import { describe, expect, it } from 'vitest';
import { RecentFilesSource } from '../recent-files-source.js';

const PROJECT = 7;

function file(id: number, path: string, kind: 'view' | 'edit' = 'view', ageMs = 0): {
  projectId: number;
  fileId: number;
  filePath: string;
  kind: 'view' | 'edit';
  lastTouchMs: number;
} {
  return { projectId: PROJECT, fileId: id, filePath: path, kind, lastTouchMs: Date.now() - ageMs };
}

describe('RecentFilesSource', () => {
  it('starts empty', () => {
    const src = new RecentFilesSource();
    expect(src.size()).toBe(0);
    expect(src.match(PROJECT, 'anything')).toEqual([]);
  });

  it('touch adds and updates entries', () => {
    const src = new RecentFilesSource();
    src.touch(file(1, 'src/core/runner.ts'));
    src.touch(file(2, 'src/core/policy.ts'));
    expect(src.size()).toBe(2);

    // Touching same fileId updates instead of adding.
    src.touch(file(1, 'src/core/runner.ts'));
    expect(src.size()).toBe(2);
  });

  it('evicts least-recently-touched when over maxSize', () => {
    const src = new RecentFilesSource({ maxSize: 3 });
    src.touch(file(1, 'a.ts'));
    src.touch(file(2, 'b.ts'));
    src.touch(file(3, 'c.ts'));
    src.touch(file(4, 'd.ts')); // evicts 1
    expect(src.size()).toBe(3);
    const matches = src.match(PROJECT, 'a b c d', 10);
    const names = matches.map((m) => m.filePath);
    expect(names).not.toContain('a.ts');
    expect(names).toEqual(expect.arrayContaining(['b.ts', 'c.ts', 'd.ts']));
  });

  it('touch updates lastTouchMs and avoids early eviction', () => {
    const src = new RecentFilesSource({ maxSize: 2 });
    src.touch(file(1, 'a.ts'));
    src.touch(file(2, 'b.ts'));
    // Re-touch 1 — it should now be newest, NOT evicted when we add 3.
    src.touch(file(1, 'a.ts'));
    src.touch(file(3, 'c.ts'));
    const names = src.match(PROJECT, 'a b c', 10).map((m) => m.filePath);
    expect(names).toContain('a.ts');
    expect(names).toContain('c.ts');
    expect(names).not.toContain('b.ts');
  });

  it('edit kind survives a subsequent view touch', () => {
    const src = new RecentFilesSource();
    src.touch(file(1, 'src/x.ts', 'edit'));
    src.touch(file(1, 'src/x.ts', 'view'));
    const matches = src.match(PROJECT, 'x', 5);
    expect(matches[0].kind).toBe('edit');
  });

  it('match isolates by projectId', () => {
    const src = new RecentFilesSource();
    src.touch({ ...file(1, 'a.ts'), projectId: 7 });
    src.touch({ ...file(2, 'a.ts'), projectId: 8 });
    const a = src.match(7, 'a');
    const b = src.match(8, 'a');
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].projectId).toBe(7);
    expect(b[0].projectId).toBe(8);
  });

  it('clearProject only drops one project', () => {
    const src = new RecentFilesSource();
    src.touch({ ...file(1, 'a.ts'), projectId: 7 });
    src.touch({ ...file(2, 'b.ts'), projectId: 8 });
    src.clearProject(7);
    expect(src.size()).toBe(1);
    expect(src.match(8, 'b')).toHaveLength(1);
  });

  it('match scores token-matching files higher than non-matching ones at equal recency', () => {
    const src = new RecentFilesSource();
    const now = Date.now();
    src.touch({ ...file(1, 'src/search/hybrid.ts'), lastTouchMs: now });
    src.touch({ ...file(2, 'src/utils/helpers.ts'), lastTouchMs: now });
    const matches = src.match(PROJECT, 'hybrid search RRF', 5, now);
    expect(matches[0].filePath).toBe('src/search/hybrid.ts');
    expect(matches[0].score).toBeGreaterThan(matches[1].score);
  });

  it('recency dominates a very stale match over a fresh non-match', () => {
    const src = new RecentFilesSource();
    const now = Date.now();
    // hybrid.ts touched 30 minutes ago — 6 half-lives in, score ≈ 0
    src.touch({ ...file(1, 'src/search/hybrid.ts'), lastTouchMs: now - 30 * 60 * 1000 });
    // helpers.ts just touched — recent, low token match
    src.touch({ ...file(2, 'src/utils/helpers.ts'), lastTouchMs: now });
    const matches = src.match(PROJECT, 'hybrid', 5, now);
    expect(matches[0].filePath).toBe('src/utils/helpers.ts');
  });

  it('edit bonus lifts equally-scored edit above view', () => {
    const src = new RecentFilesSource();
    const now = Date.now();
    src.touch({ ...file(1, 'a/edited.ts', 'edit'), lastTouchMs: now });
    src.touch({ ...file(2, 'a/viewed.ts', 'view'), lastTouchMs: now });
    const matches = src.match(PROJECT, 'unrelated', 5, now);
    expect(matches[0].filePath).toBe('a/edited.ts');
  });

  it('empty query returns recent-only ranking with zero token-match contribution', () => {
    const src = new RecentFilesSource();
    const now = Date.now();
    src.touch({ ...file(1, 'a.ts'), lastTouchMs: now - 1000 });
    src.touch({ ...file(2, 'b.ts'), lastTouchMs: now });
    const matches = src.match(PROJECT, '', 5, now);
    expect(matches).toHaveLength(2);
    // Newer touch wins.
    expect(matches[0].filePath).toBe('b.ts');
  });

  it('respects limit', () => {
    const src = new RecentFilesSource();
    for (let i = 1; i <= 10; i++) src.touch(file(i, `f${i}.ts`));
    expect(src.match(PROJECT, 'f', 3)).toHaveLength(3);
  });

  it('limit <= 0 returns empty', () => {
    const src = new RecentFilesSource();
    src.touch(file(1, 'a.ts'));
    expect(src.match(PROJECT, 'a', 0)).toEqual([]);
    expect(src.match(PROJECT, 'a', -1)).toEqual([]);
  });

  it('clear empties everything', () => {
    const src = new RecentFilesSource();
    src.touch(file(1, 'a.ts'));
    src.touch(file(2, 'b.ts'));
    src.clear();
    expect(src.size()).toBe(0);
  });

  it('matchedTerms reflects which query tokens matched', () => {
    const src = new RecentFilesSource();
    src.touch(file(1, 'src/search/hybrid.ts'));
    const matches = src.match(PROJECT, 'hybrid search unrelated');
    expect(matches[0].matchedTerms).toEqual(expect.arrayContaining(['hybrid', 'search']));
    expect(matches[0].matchedTerms).not.toContain('unrelated');
  });
});
