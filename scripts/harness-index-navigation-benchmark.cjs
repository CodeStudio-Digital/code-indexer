// Isolated SQLite fixture. Run with Electron's Node mode so its SQLite ABI
// matches the built application. This measures reads, not provider latency.
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const assert = require('node:assert/strict');
const { CodeIndexDB } = require('../dist/packages/store/src/db.js');
const root = mkdtempSync(join(tmpdir(), 'codestudio-index-bench-'));
const db = new CodeIndexDB(join(root, 'index.db'));
const report = { fixture: 'isolated SQLite; warm cache; five samples; no cloud provider', results: [] };
const measure = fn => {
  fn(); const samples = [];
  for (let i = 0; i < 5; i++) { const start = performance.now(); fn(); samples.push(performance.now() - start); }
  samples.sort((a, b) => a - b); return { medianMs: samples[2], maxMs: samples[4] };
};
try {
  const project = db.createProject('benchmark', root); let inserted = 0;
  for (const count of [1000, 10000, 50000]) {
    const raw = db.projectScopedDb(project.id);
    raw.transaction(() => {
      for (; inserted < count; inserted++) db.upsertFile(project.id, { path: 'src/file-' + String(inserted).padStart(6, '0') + '.ts',
        language: 'typescript', size: 4096, lineCount: 100, contentHash: 'fixture-' + inserted,
        dependencies: Array.from({ length: 10 }, (_, i) => './dependency-' + i) });
    })();
    const legacy = () => db.listFiles(project.id).sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')).slice(0, 20);
    const bounded = () => db.listAgentIndexFiles(project.id, { limit: 20, order: 'updated' });
    assert.equal(bounded().total, count); assert.equal(bounded().items.length, 20);
    const fullPayloadBytes = Buffer.byteLength(JSON.stringify(db.listFiles(project.id)));
    const pagePayloadBytes = Buffer.byteLength(JSON.stringify(bounded()));
    const shapeStart = performance.now(); db.getAgentProjectShape(project.id); const shapeColdMs = performance.now() - shapeStart;
    report.results.push({ files: count, legacy: measure(legacy), bounded: measure(bounded), shapeColdMs,
      aggregateShapeWarm: measure(() => db.getAgentProjectShape(project.id)), fullPayloadBytes, pagePayloadBytes });
  }
  if (process.argv[2]) writeFileSync(resolve(process.argv[2]), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { db.close(); rmSync(root, { recursive: true, force: true }); }
