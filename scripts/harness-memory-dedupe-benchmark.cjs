// Run with Electron's Node ABI against the compiled candidate. Synthetic CPU
// timing only; compare the exact retained ids before drawing any conclusions.
const { performance } = require('node:perf_hooks');
const { dedupeAgentMemoryHits } = require('../dist/packages/services/src/memory/agent-memory-service.js');
const cases = [20, 60, 120].map(count => {
  const rows = Array.from({ length: count }, (_, i) => ({ id: i, source: 'session', score: 1 - i / count,
    name: 'topic' + i, content: Array.from({ length: 512 }, (_, j) => `memory${i}term${j}`).join(' ').repeat(3) }));
  const samples = []; let ids;
  for (let n = 0; n < 4; n++) { const start = performance.now(); ids = dedupeAgentMemoryHits(rows).map(r => r.id); samples.push(performance.now() - start); }
  return { candidates: count, bodyBytes: rows.reduce((sum, r) => sum + Buffer.byteLength(r.content), 0), retainedIds: ids,
    warmMedianMs: samples.slice(1).sort((a, b) => a - b)[1], samplesMs: samples };
});
console.log(JSON.stringify({ cases }, null, 2));
