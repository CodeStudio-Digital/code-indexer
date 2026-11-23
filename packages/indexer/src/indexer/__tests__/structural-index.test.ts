/**
 * Structural pipeline and incremental reconciliation.
 *
 * Central contracts under test:
 *  - structural run: $0, no provider, symbols + content FTS populated,
 *    structural_indexed_at stamped, last_indexed untouched, structural run recorded.
 *  - watcher-grade indexFilesStructural: hash short-circuit + delete handling.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeStructuralHarness,
  smallFileFixture,
  type StructuralHarness,
} from './structural-test-harness.js';
import { runStructuralIndex, sweepContentCoverage } from '../structural.js';
import { FileScanner } from '../scanner.js';
import { indexFilesStructural, removeFilesStructural } from '../structural-incremental.js';
import { hashContent } from '../content-hash.js';

describe('structural index pipeline', () => {
  let h: StructuralHarness;

  beforeEach(() => {
    h = makeStructuralHarness();
    h.writeFile('alpha.ts', smallFileFixture('alphaFn'));
    h.writeFile('beta.ts', smallFileFixture('betaFn'));
  });

  afterEach(() => h.dispose());

  it('stops during a new scan and keeps the previous index searchable', async () => {
    await runStructuralIndex(h.db, h.projectId);
    const ctrl = new AbortController();
    let checkpoints = 0;
    const result = await runStructuralIndex(h.db, h.projectId, {
      signal: ctrl.signal,
      waitForInteractivePriority: async () => { if (++checkpoints === 2) ctrl.abort(); },
    });
    expect(result).toMatchObject({ aborted: 'signal', indexed: 0, removed: 0 });
    expect(h.db.searchFileContents(h.projectId, 'betaFn').map(hit => hit.path)).toEqual(['beta.ts']);
  });

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

  it('uses the current snapshot and skips new files that disappear or grow after discovery', async () => {
    h.writeFile('empty.ts', '');
    h.writeFile('growing.ts', 'export const small = 1;');
    const indexContent = vi.spyOn(h.db, 'upsertFileContent');
    const replacement = 'export function refreshed() { return "leitura"; }\n';
    const result = await runStructuralIndex(h.db, h.projectId, {
      maxFileSizeKB: 1,
      onChanges: () => {
        h.writeFile('alpha.ts', replacement);
        h.deleteFile('beta.ts');
        h.writeFile('growing.ts', ' '.repeat(1025));
      },
    });

    expect(result).toMatchObject({ totalFiles: 4, indexed: 2, skipped: 2, errorCount: 0 });
    expect(h.db.listFiles(h.projectId).map(file => file.path)).toEqual(['alpha.ts', 'empty.ts']);
    expect(h.db.getFile(h.projectId, 'alpha.ts')?.content_hash).toBe(hashContent(replacement));
    const empty = h.db.getFile(h.projectId, 'empty.ts')!;
    expect(empty.content_hash).toBe(hashContent(''));
    expect(indexContent.mock.calls.filter(([fileId]: [number, ...unknown[]]) => fileId === empty.id)).toHaveLength(1);
    expect(h.db.getSymbolsByFile(h.projectId, 'alpha.ts').map(symbol => symbol.name)).toEqual(['refreshed']);
    expect(h.db.searchFileContents(h.projectId, 'refreshed').map(file => file.path)).toEqual(['alpha.ts']);
  });

  it('preserves a previous generation if the only new candidate disappears before preparation', async () => {
    expect((await h.indexStructural()).indexed).toBe(2);
    h.deleteFile('alpha.ts');
    h.deleteFile('beta.ts');
    h.writeFile('temporary.ts', 'export const temp = 1;');

    const result = await runStructuralIndex(h.db, h.projectId, {
      onChanges: () => h.deleteFile('temporary.ts'),
    });

    expect(result).toMatchObject({ aborted: 'empty_scan', indexed: 0, removed: 0 });
    expect(h.db.listFiles(h.projectId).map(file => file.path)).toEqual(['alpha.ts', 'beta.ts']);
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

  it('resumes a large publication from committed files and delays removals until upserts finish', async () => {
    await h.indexStructural();
    h.deleteFile('beta.ts');
    const content = 'resumable coverage\n';
    h.writeFile('first.txt', content);
    h.writeFile('second.txt', content);
    const paths = ['first.txt', 'second.txt', ...Array.from({ length: 999 }, (_, i) => `pending-${i}.txt`)];
    const scan = vi.spyOn(FileScanner.prototype, 'scan').mockResolvedValueOnce({
      toIndex: paths.map(relativePath => ({
        path: join(h.projectRoot, relativePath), relativePath, content, hash: hashContent(content),
        sizeBytes: Buffer.byteLength(content), lineCount: 2,
      })),
      unchanged: ['alpha.ts'],
      toRemove: ['beta.ts'],
    });
    vi.stubEnv('MCP_INDEX_WRITE_BATCH_SIZE', '1');
    try {
      const controller = new AbortController();
      const changes: string[] = [];
      const partial = await runStructuralIndex(h.db, h.projectId, {
        signal: controller.signal,
        onChanges: (events) => {
          changes.push(...events.map(event => event.path));
          if (events.some(event => event.path === 'second.txt')) controller.abort();
        },
      });
      expect(partial).toMatchObject({ aborted: 'signal', indexed: 1, removed: 0 });
      expect(changes).toEqual(['first.txt', 'second.txt']);
      expect(h.db.searchFileContents(h.projectId, 'resumable').map(row => row.path)).toEqual(['first.txt']);
      expect(h.db.getFile(h.projectId, 'beta.ts')).toBeTruthy();
      const retry = await runStructuralIndex(h.db, h.projectId);
      expect(retry).toMatchObject({ indexed: 1, removed: 1, errorCount: 0 });
      expect(h.db.searchFileContents(h.projectId, 'resumable')).toHaveLength(2);
    } finally {
      vi.unstubAllEnvs();
      scan.mockRestore();
    }
  });

  it('memoizes FTS exclusions by snapshot and repairs only content matching committed hashes', async () => {
    const path = 'coverage.txt';
    h.writeFile(path, 'z'.repeat(5_000));
    await h.indexStructural();
    const scoped = h.db.projectScopedDb(h.projectId);
    scoped.prepare('UPDATE files SET content_fts_exclusion = NULL WHERE path = ?').run(path);
    const revision = h.db.getStructuralRevision(h.projectId);

    expect(await sweepContentCoverage(h.db, h.projectId, h.projectRoot)).toEqual({ added: 0, skipped: 1 });
    expect(h.db.getStructuralRevision(h.projectId)).toBe(revision);
    expect(await sweepContentCoverage(h.db, h.projectId, h.projectRoot)).toEqual({ added: 0, skipped: 0 });
    h.writeFile(path, 'now searchable\n');
    expect((await h.indexStructural()).indexed).toBe(1);
    expect(h.db.searchFileContents(h.projectId, 'searchable').map(hit => hit.path)).toEqual([path]);

    const file = h.db.getFile(h.projectId, path)!;
    h.db.removeFileContent(file.id, h.projectId);
    expect(await sweepContentCoverage(h.db, h.projectId, h.projectRoot)).toEqual({ added: 1, skipped: 0 });
    expect(h.db.searchFileContents(h.projectId, 'searchable').map(hit => hit.path)).toEqual([path]);
    h.db.removeFileContent(file.id, h.projectId);
    h.writeFile(path, 'oops unindexed\n');
    expect(await sweepContentCoverage(h.db, h.projectId, h.projectRoot)).toEqual({ added: 0, skipped: 1 });
    expect(h.db.searchFileContents(h.projectId, 'unindexed')).toEqual([]);
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
    expect(h.db.getProjectCatalogEntry(h.projectId)).toMatchObject(h.db.getStructuralCounts(h.projectId));

    // Deleted on disk → row + symbols + content index all cleared.
    h.deleteFile('beta.ts');
    const removedViaIndex = await indexFilesStructural(h.db, h.projectId, ['beta.ts']);
    expect(removedViaIndex.removed).toBe(1);
    expect(h.db.getProjectCatalogEntry(h.projectId)).toMatchObject(h.db.getStructuralCounts(h.projectId));
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
