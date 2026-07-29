/**
 * Structural pipeline and incremental reconciliation.
 *
 * Central contracts under test:
 *  - structural run: $0, no provider, symbols + content FTS populated,
 *    structural_indexed_at stamped, last_indexed untouched, structural run recorded.
 *  - watcher-grade indexFilesStructural: hash short-circuit + delete handling.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeStructuralHarness,
  smallFileFixture,
  type StructuralHarness,
} from './structural-test-harness.js';
import { runStructuralIndex } from '../structural.js';
import { indexFilesStructural, removeFilesStructural } from '../structural-incremental.js';

describe('structural index pipeline', () => {
  let h: StructuralHarness;

  beforeEach(() => {
    h = makeStructuralHarness();
    h.writeFile('alpha.ts', smallFileFixture('alphaFn'));
    h.writeFile('beta.ts', smallFileFixture('betaFn'));
  });

  afterEach(() => h.dispose());

  it('dumb mode: indexes symbols + content for $0 without any provider', async () => {
    const result = await runStructuralIndex(h.db, h.projectId, { concurrency: 1 });

    expect(result.aborted).toBeUndefined();
    expect(result.indexed).toBe(2);
    expect(result.errorCount).toBe(0);
    expect(result.phaseTimings).toEqual({
      scanMs: expect.any(Number),
      parseMs: expect.any(Number),
      writeMs: expect.any(Number),
      sweepMs: expect.any(Number),
    });
    expect(result.peakRssMb).toBeGreaterThan(0);

    const project = h.db.getProject(h.projectId)!;
    expect(project.structural_indexed_at).toBeTruthy();
    expect(project.last_indexed).toBeNull();          // semantic stamp untouched
    expect(project.symbol_count).toBeGreaterThan(0);

    const alpha = h.db.getFile(h.projectId, 'alpha.ts')!;
    expect(alpha.is_entry_point).toBe(0);
    expect(h.db.getSymbolsByFile(h.projectId, 'alpha.ts').map((s) => s.name)).toContain('alphaFn');
    expect(h.db.countFileContents(h.projectId)).toBe(2);
    expect(h.db.searchFileContents(h.projectId, 'betaFn').map((m) => m.path)).toEqual(['beta.ts']);

    const persistedRun = h.db.getRun(result.runId!);
    expect(persistedRun).toMatchObject({
      project_id: h.projectId,
      status: 'completed',
      peak_rss_mb: result.peakRssMb,
    });
    expect(JSON.parse(persistedRun!.phase_timings_json!)).toEqual({
      scan_ms: result.phaseTimings.scanMs,
      parse_ms: result.phaseTimings.parseMs,
      write_ms: result.phaseTimings.writeMs,
      sweep_ms: result.phaseTimings.sweepMs,
    });
    const costs = h.db.raw().prepare('SELECT COUNT(*) as c FROM costs WHERE project_id = ?')
      .get(h.projectId) as { c: number };
    expect(costs.c).toBe(0);

    // Semantic coverage is tracked independently by semantic_items.
    expect(h.db.countSemanticStale(h.projectId)).toBe(0);
  });

  it('too_large gate bails without touching the project', async () => {
    const result = await runStructuralIndex(h.db, h.projectId, { maxFiles: 1 });
    expect(result.aborted).toBe('too_large');
    expect(h.db.getProject(h.projectId)!.structural_indexed_at).toBeNull();
    expect(h.db.listFiles(h.projectId)).toHaveLength(0);
  });

  it('reports exact scan deltas before the first structural mutation', async () => {
    const observed: Array<{ path: string; kind: 'upsert' | 'delete' }> = [];
    const result = await runStructuralIndex(h.db, h.projectId, {
      concurrency: 1,
      onChanges: (events) => {
        observed.push(...events);
        expect(h.db.listFiles(h.projectId)).toHaveLength(0);
      },
    });

    expect(result.indexed).toBe(2);
    expect(observed.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'alpha.ts', kind: 'upsert' },
      { path: 'beta.ts', kind: 'upsert' },
    ]);
  });

  it('does not mutate structural rows when the semantic delta fence fails', async () => {
    await expect(runStructuralIndex(h.db, h.projectId, {
      concurrency: 1,
      onChanges: () => {
        throw new Error('semantic fence unavailable');
      },
    })).rejects.toThrow('semantic fence unavailable');

    expect(h.db.listFiles(h.projectId)).toHaveLength(0);
    expect(h.db.getRuns(h.projectId)).toHaveLength(0);
  });

  it('records no history item for a stat-first reconciliation with no changes', async () => {
    const first = await runStructuralIndex(h.db, h.projectId, { concurrency: 1 });
    const stamp = h.db.getProject(h.projectId)!.structural_indexed_at;
    const runsBefore = h.db.getRuns(h.projectId, 20).map((run) => run.id);
    h.db.raw().prepare(
      `UPDATE projects SET updated_at = 'sentinel', structural_last_checked_at = NULL WHERE id = ?`,
    ).run(h.projectId);

    const noop = await runStructuralIndex(h.db, h.projectId, { concurrency: 1 });

    expect(first.runId).toBeTypeOf('number');
    expect(noop.runId).toBeUndefined();
    expect(noop.indexed).toBe(0);
    expect(noop.removed).toBe(0);
    expect(noop.skipped).toBe(2);
    expect(h.db.getRuns(h.projectId, 20).map((run) => run.id)).toEqual(runsBefore);
    expect(h.db.getProject(h.projectId)!.structural_indexed_at).toBe(stamp);
    expect(h.db.getProject(h.projectId)!.structural_last_checked_at).not.toBeNull();
    expect(h.db.getProject(h.projectId)!.updated_at).toBe('sentinel');
  });

  it('empty scan over a populated index: anti-wipe guard + no ready stamp', async () => {
    await runStructuralIndex(h.db, h.projectId, { concurrency: 1 });
    expect(h.db.listFiles(h.projectId)).toHaveLength(2);

    // Simulate a broken root (renamed dir / wrong root_path): scan sees 0
    // files while the index has rows. Without the guard this WIPED the index.
    h.deleteFile('alpha.ts');
    h.deleteFile('beta.ts');
    const stampBefore = h.db.getProject(h.projectId)!.structural_indexed_at;
    const result = await runStructuralIndex(h.db, h.projectId, { concurrency: 1 });
    expect(result.aborted).toBe('empty_scan');
    expect(result.removed).toBe(0);
    expect(h.db.listFiles(h.projectId)).toHaveLength(2);           // index intact
    expect(h.db.getProject(h.projectId)!.structural_indexed_at).toBe(stampBefore);

    // Manual escape hatch: explicit reindex IS allowed to empty the index.
    const manual = await runStructuralIndex(h.db, h.projectId, { concurrency: 1, allowEmptyWipe: true });
    expect(manual.aborted).toBeUndefined();
    expect(manual.removed).toBe(2);
    expect(h.db.listFiles(h.projectId)).toHaveLength(0);
  });

  it('watcher-grade: hash short-circuit, re-index, delete', async () => {
    await runStructuralIndex(h.db, h.projectId, { concurrency: 1 });

    // Same content → short-circuit (the anti-double-index guard).
    const noop = await indexFilesStructural(h.db, h.projectId, ['alpha.ts']);
    expect(noop.skippedUnchanged).toBe(1);
    expect(noop.indexed).toBe(0);

    // Real edit → re-index (also accepts backslash paths at the boundary).
    writeFileSync(join(h.projectRoot, 'alpha.ts'), smallFileFixture('renamedFn'), 'utf-8');
    const edited = await indexFilesStructural(h.db, h.projectId, ['alpha.ts']);
    expect(edited.indexed).toBe(1);
    expect(h.db.getSymbolsByFile(h.projectId, 'alpha.ts').map((s) => s.name)).toContain('renamedFn');

    // New file never seen before → row created (indexFileNow can't do this).
    h.writeFile('gamma.ts', smallFileFixture('gammaFn'));
    const added = await indexFilesStructural(h.db, h.projectId, ['gamma.ts']);
    expect(added.indexed).toBe(1);
    expect(h.db.getFile(h.projectId, 'gamma.ts')).toBeTruthy();

    // Deleted on disk → row + symbols + content index all cleared.
    h.deleteFile('beta.ts');
    const removedViaIndex = await indexFilesStructural(h.db, h.projectId, ['beta.ts']);
    expect(removedViaIndex.removed).toBe(1);
    expect(h.db.getFile(h.projectId, 'beta.ts')).toBeUndefined();
    expect(h.db.getSymbolsByFile(h.projectId, 'beta.ts')).toHaveLength(0);
    expect(h.db.searchFileContents(h.projectId, 'betaFn')).toHaveLength(0);

    // Explicit remove API is idempotent.
    expect(removeFilesStructural(h.db, h.projectId, ['beta.ts']).removed).toBe(0);

    // Ignored paths never reach the index.
    const ignored = await indexFilesStructural(h.db, h.projectId, ['node_modules/x/y.js']);
    expect(ignored.skippedIgnored).toBe(1);
  });

  it('project ignore rules remove stale structural rows', async () => {
    mkdirSync(join(h.projectRoot, 'generated'));
    h.writeFile('generated/client.ts', smallFileFixture('generatedFn'));

    await runStructuralIndex(h.db, h.projectId, { concurrency: 1 });
    expect(h.db.getFile(h.projectId, 'generated/client.ts')).toBeTruthy();

    h.db.updateProject(h.projectId, { index_ignore_patterns: JSON.stringify(['generated/']) });

    const incremental = await indexFilesStructural(h.db, h.projectId, ['generated/client.ts']);
    expect(incremental.skippedIgnored).toBe(1);
    expect(incremental.removed).toBe(1);
    expect(h.db.getFile(h.projectId, 'generated/client.ts')).toBeUndefined();

    h.writeFile('generated/client.ts', smallFileFixture('generatedFn'));
    await runStructuralIndex(h.db, h.projectId, { concurrency: 1 });
    expect(h.db.getFile(h.projectId, 'generated/client.ts')).toBeUndefined();
  });
});
