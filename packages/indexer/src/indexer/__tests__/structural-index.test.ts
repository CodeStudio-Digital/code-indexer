/**
 * Structural pipeline (dumb mode) + dumb→smart reuse.
 *
 * Central contracts under test:
 *  - structural run: $0, no provider, symbols + content FTS populated,
 *    structural_indexed_at stamped, last_indexed untouched, runs.kind.
 *  - structural after full PRESERVES the semantic layer and marks staleness.
 *  - the next full run processes exactly the stale set (semantic catch-up).
 *  - watcher-grade indexFilesStructural: hash short-circuit + delete handling.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHarness, smallFileFixture, FakeProvider, type Harness } from './index-agent-harness.js';
import { runStructuralIndex } from '../structural.js';
import { indexFilesStructural, removeFilesStructural } from '../structural-incremental.js';
import { IndexAgent } from '../indexer.js';
import { CostTracker } from '@mcp/services/services/costs.js';
import type { AnalysisResult } from '@mcp/shared/types.js';
import type { IndexerConfig } from '@mcp/shared/utils/config.js';

class CountingProvider extends FakeProvider {
  analyzed: string[] = [];
  override async analyzeFile(filePath: string, content: string): Promise<AnalysisResult> {
    this.analyzed.push(filePath);
    return super.analyzeFile(filePath, content);
  }
}

describe('structural index pipeline', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
    h.writeFile('alpha.ts', smallFileFixture('alphaFn'));
    h.writeFile('beta.ts', smallFileFixture('betaFn'));
  });

  afterEach(() => h.dispose());

  it('dumb mode: indexes symbols + content for $0 without any provider', async () => {
    const result = await runStructuralIndex(h.db, h.projectId, { concurrency: 1 });

    expect(result.aborted).toBeUndefined();
    expect(result.indexed).toBe(2);
    expect(result.errorCount).toBe(0);

    const project = h.db.getProject(h.projectId)!;
    expect(project.structural_indexed_at).toBeTruthy();
    expect(project.last_indexed).toBeNull();          // semantic stamp untouched
    expect(project.symbol_count).toBeGreaterThan(0);

    const alpha = h.db.getFile(h.projectId, 'alpha.ts')!;
    expect(alpha.summary).toBe('');                    // no LLM ran
    expect(h.db.getSymbolsByFile(h.projectId, 'alpha.ts').map((s) => s.name)).toContain('alphaFn');
    expect(h.db.countFileContents(h.projectId)).toBe(2);
    expect(h.db.searchFileContents(h.projectId, 'betaFn').map((m) => m.path)).toEqual(['beta.ts']);

    expect(h.db.getRun(result.runId!)!.kind).toBe('structural');
    const costs = h.db.raw().prepare('SELECT COUNT(*) as c FROM costs WHERE project_id = ?')
      .get(h.projectId) as { c: number };
    expect(costs.c).toBe(0);

    // Everything is semantically stale — nothing has seen the LLM yet.
    expect(h.db.countSemanticStale(h.projectId)).toBe(2);
  });

  it('too_large gate bails without touching the project', async () => {
    const result = await runStructuralIndex(h.db, h.projectId, { maxFiles: 1 });
    expect(result.aborted).toBe('too_large');
    expect(h.db.getProject(h.projectId)!.structural_indexed_at).toBeNull();
    expect(h.db.listFiles(h.projectId)).toHaveLength(0);
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

  it('structural after full preserves semantics; next full catches up exactly the stale set', async () => {
    const provider = new CountingProvider();
    const config = {
      dbPath: join(h.dir, 'index.db'), concurrency: 1, maxFileSize: 200,
      ignorePatterns: [], indexProfile: 'balanced',
    } as unknown as IndexerConfig;
    const agent = new IndexAgent(h.db, provider, h.embedding, h.vectorStore, new CostTracker(h.db), null, config);

    // 1. Full index — both files get summaries, semantic_hash stamped.
    await agent.indexProject(h.projectRoot);
    expect(provider.analyzed).toHaveLength(2);
    expect(h.db.countSemanticStale(h.projectId)).toBe(0);
    expect(h.db.getFile(h.projectId, 'alpha.ts')!.summary).toContain('Summary of');

    // 2. Structure-changing edit + STRUCTURAL pass.
    h.writeFile('alpha.ts', `${smallFileFixture('alphaFn')}\nexport function extraFn(): number { return 42; }\n`);
    const structural = await runStructuralIndex(h.db, h.projectId, { concurrency: 1 });
    expect(structural.indexed).toBe(1);                // only the edited file

    const alpha = h.db.getFile(h.projectId, 'alpha.ts')!;
    expect(alpha.summary).toContain('Summary of');     // semantic layer SURVIVED
    expect(h.db.getSymbolsByFile(h.projectId, 'alpha.ts').map((s) => s.name)).toContain('extraFn');
    expect(h.db.countSemanticStale(h.projectId)).toBe(1);
    expect(h.db.searchFileContents(h.projectId, 'extraFn').map((m) => m.path)).toEqual(['alpha.ts']);

    // 3. Next FULL run: scanner says "unchanged" (structural advanced the
    //    hash) — the semantic catch-up set must re-process EXACTLY alpha.ts,
    //    and the structure change must reach the LLM (structure_hash was not
    //    poisoned by the structural pass).
    provider.analyzed = [];
    await agent.indexProject(h.projectRoot);
    expect(provider.analyzed).toEqual(['alpha.ts']);
    expect(h.db.countSemanticStale(h.projectId)).toBe(0);
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
