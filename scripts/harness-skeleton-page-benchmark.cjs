// Synthetic comparison of the previous full hydration algorithm and bounded
// SQL projection on the same database. This is not provider/production latency.
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const { CodeIndexDB } = require('../dist/packages/store/src/db.js');
const root = mkdtempSync(join(tmpdir(), 'outline-benchmark-'));
const db = new CodeIndexDB(join(root, 'index.db'));
try {
  const project = db.createProject('outline-benchmark', root);
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
    const all = db.listFiles(project.id).filter(f => f.path.startsWith('src/'))
      .flatMap(f => db.getSymbolsByFile(project.id, f.path).filter(s => s.exported));
    return { total: all.length, symbols: all.slice(0, 100), materialized: all };
  };
  const newRead = () => {
    const page = db.getAgentFileSkeleton(project.id, 'src', { offset: 0, limit: 100 });
    return { ...page, materialized: page.symbols };
  };
  const measure = fn => {
    const samplesMs = []; let value;
    for (let i = 0; i < 4; i++) { const start = performance.now(); value = fn(); samplesMs.push(performance.now() - start); }
    return { samplesMs, warmMedianMs: samplesMs.slice(1).sort((a, b) => a - b)[1],
      total: value.total, materializedRows: value.materialized.length,
      materializedBytes: Buffer.byteLength(JSON.stringify(value.materialized)),
      selected: value.symbols.map(s => `${s.file_path}:${s.line}:${s.name}`) };
  };
  const before = measure(oldRead), after = measure(newRead);
  assert.equal(before.total, after.total); assert.deepEqual(before.selected, after.selected);
  delete before.selected; delete after.selected;
  console.log(JSON.stringify({ passed: true, indexedFiles: 2000, symbols: 16000, outputEquivalent: true, before, after }, null, 2));
} finally { db.close(); rmSync(root, { recursive: true, force: true }); }
