// Same-database synthetic comparison; this is not a provider or production p95.
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const { CodeIndexDB } = require('../dist/packages/store/src/db.js');
const root = mkdtempSync(join(tmpdir(), 'repo-map-benchmark-'));
const db = new CodeIndexDB(join(root, 'index.db'));
try {
  const project = db.createProject('map-benchmark', root);
  db.raw().transaction(() => {
    for (let i = 0; i < 2000; i++) {
      const path = `src/file-${String(i).padStart(4, '0')}.ts`;
      const id = db.upsertFile(project.id, { path, language: 'typescript', size: 1000, lineCount: 100, contentHash: 'fixture' });
      db.upsertSymbols(project.id, id, path, Array.from({ length: 8 }, (_, j) => ({
        name: `fn${j}`, kind: 'function', signature: `fn${j}()`, parent: null, modifiers: [], return_type: null,
        parameters: null, line: j + 1, exported: true, comment: 'x'.repeat(1000), tags: [],
      })));
    }
  })();
  const oldRead = () => {
    const files = db.listFiles(project.id), materialized = [...files], scores = [];
    for (const file of files) {
      const deps = db.getDependents(project.id, file.id), symbols = db.getSymbolsByFile(project.id, file.path);
      materialized.push(...deps, ...symbols);
      scores.push({ path: file.path, score: deps.length * 3 + Math.min(symbols.length, 10), symbols: symbols.slice(0, 3) });
    }
    scores.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return { items: scores.slice(0, 100), materialized };
  };
  const newRead = () => {
    const page = db.listAgentRepoMap(project.id, { limit: 100 });
    return { items: page.items, materialized: page.items.flatMap(f => [f, ...f.symbols]) };
  };
  const measure = fn => {
    const samplesMs = []; let value;
    for (let i = 0; i < 4; i++) { const start = performance.now(); value = fn(); samplesMs.push(performance.now() - start); }
    return { samplesMs, warmMedianMs: samplesMs.slice(1).sort((a, b) => a - b)[1],
      materializedRows: value.materialized.length, materializedBytes: Buffer.byteLength(JSON.stringify(value.materialized)),
      selected: value.items.map(f => ({ path: f.path, score: f.score, symbols: f.symbols.map(s => [s.name, s.kind, s.signature]) })) };
  };
  const before = measure(oldRead), after = measure(newRead);
  assert.deepEqual(before.selected, after.selected); delete before.selected; delete after.selected;
  console.log(JSON.stringify({ passed: true, indexedFiles: 2000, symbols: 16000, selectedFiles: 100, outputEquivalent: true, before, after }, null, 2));
} finally { db.close(); rmSync(root, { recursive: true, force: true }); }
