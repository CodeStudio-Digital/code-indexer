/**
 * End-to-end validation of the tiered-hybrid INDEX routing (P2b) using the REAL
 * structural pipeline (FileScanner + tree-sitter WASM), not synthetic rows.
 *
 * With MCP_PROJECT_DB_ROUTE on, a structural index of a migrated project must:
 *  - write files/symbols/content-FTS into <root>/.mcp-indexer/index.db,
 *  - leave the central DB frozen (no project rows), and
 *  - serve routed reads (listFiles / searchSymbols / searchFileContents) from
 *    the project DB.
 *
 * ABI: needs `pnpm node:rebuild`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openRawProjectDb } from '@mcp/store/project-db/index.js';
import { makeHarness, smallFileFixture, type Harness } from './index-agent-harness.js';
import { runStructuralIndex } from '../structural.js';

function setRouteFlags(): void {
  process.env.MCP_PROJECT_DB = '1';
  process.env.MCP_PROJECT_DB_SPLIT = '1';
  process.env.MCP_PROJECT_DB_ROUTE = '1';
}
function clearFlags(): void {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('MCP_PROJECT_DB') || k.startsWith('MCP_DB_SPLIT')) delete process.env[k];
  }
}

let h: Harness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
  clearFlags();
});

describe('tiered-hybrid INDEX routing — real structural pipeline (P2b)', () => {
  it('routes a real structural index into the project DB; central stays frozen', async () => {
    setRouteFlags();
    h = makeHarness(); // constructs CodeIndexDB AFTER flags are set → routing on
    h.writeFile('alpha.ts', smallFileFixture('alphaFn'));
    h.writeFile('beta.ts', smallFileFixture('betaFn'));

    const result = await runStructuralIndex(h.db, h.projectId, { concurrency: 1 });
    expect(result.aborted).toBeUndefined();
    expect(result.indexed).toBe(2);

    // The project was migrated (ensureProjectSplit) and routing flipped on.
    expect(h.db.getProjectSplitStatus(h.projectId)).toBe('done');
    expect(h.db.useProjectDb(h.projectId)).toBe(true);

    // The project DB exists and holds the index.
    const projDbPath = join(h.projectRoot, '.mcp-indexer', 'index.db');
    expect(existsSync(projDbPath)).toBe(true);
    const proj = openRawProjectDb(projDbPath, { readonly: true });
    try {
      const files = (proj.prepare('SELECT COUNT(*) n FROM files').get() as { n: number }).n;
      const syms = (proj.prepare('SELECT COUNT(*) n FROM symbols').get() as { n: number }).n;
      expect(files).toBe(2);
      expect(syms).toBeGreaterThan(0);
    } finally {
      proj.close();
    }

    // Central is frozen — the structural writes did NOT land there.
    const centralFiles = (h.db.raw().prepare(
      'SELECT COUNT(*) n FROM files WHERE project_id = ?',
    ).get(h.projectId) as { n: number }).n;
    expect(centralFiles).toBe(0);

    // Routed reads serve from the project DB.
    expect(h.db.listFiles(h.projectId).map((f) => f.path).sort()).toEqual(['alpha.ts', 'beta.ts']);
    expect(h.db.getSymbolsByFile(h.projectId, 'alpha.ts').map((s) => s.name)).toContain('alphaFn');
    expect(h.db.searchFileContents(h.projectId, 'betaFn').map((m) => m.path)).toEqual(['beta.ts']);

    // The run was written + read back through the project DB (finishRun threaded).
    expect(h.db.getRun(result.runId!, h.projectId)?.kind).toBe('structural');
  });

  it('watcher-grade incremental write also routes to the project DB', async () => {
    setRouteFlags();
    h = makeHarness();
    h.writeFile('alpha.ts', smallFileFixture('alphaFn'));
    await runStructuralIndex(h.db, h.projectId, { concurrency: 1 });

    // Add a file and index it incrementally (watcher path).
    h.writeFile('gamma.ts', smallFileFixture('gammaFn'));
    const { indexFilesStructural } = await import('../structural-incremental.js');
    const r = await indexFilesStructural(h.db, h.projectId, ['gamma.ts']);
    expect(r.indexed).toBe(1);

    // Routed read sees the new file; central never got it.
    expect(h.db.getFile(h.projectId, 'gamma.ts')?.path).toBe('gamma.ts');
    const centralHas = h.db.raw().prepare(
      "SELECT COUNT(*) n FROM files WHERE project_id = ? AND path = 'gamma.ts'",
    ).get(h.projectId) as { n: number };
    expect(centralHas.n).toBe(0);
  });
});
