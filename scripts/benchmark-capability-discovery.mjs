// Reproduces warm discovery overhead with identical catalogs and responses.
// Run after the TypeScript build; no provider, database or user profile needed.
import assert from 'node:assert/strict';
import { ToolRegistry } from '../dist/packages/code-agent/src/core/registry.js';
import { buildCapabilityCatalogTool } from '../dist/packages/code-agent/src/tools/capability-catalog-tool.js';

const count = 1000;
function fixture(sealed) {
  const registry = new ToolRegistry();
  for (let i = 0; i < count; i++) registry.register({ name: `fixture_read_${String(i).padStart(4, '0')}`,
    source: 'native', description: 'Read an isolated fixture without mutating project state. '.repeat(8),
    mutates: false, parallelSafe: true, riskLevel: 'read', parameters: { type: 'object', properties: {
      path: { type: 'string', description: 'Project relative path' }, limit: { type: 'integer', minimum: 1, maximum: 100 },
    } }, handler: async () => ({ content: 'unused' }) });
  const catalog = buildCapabilityCatalogTool({ registry, skills: [], skillTemplateContext: {} });
  if (sealed) registry.seal();
  return () => catalog.handler({ op: 'list', limit: 10 }, { cwd: process.cwd(), projectName: 'benchmark' });
}
const mutable = fixture(false), sealed = fixture(true);
const timing = { repeatedDescriptors: [], sealedCache: [] };
let reference;
for (let round = 0; round < 30; round++) {
  for (const [label, run] of round % 2 ? [['sealedCache', sealed], ['repeatedDescriptors', mutable]] : [['repeatedDescriptors', mutable], ['sealedCache', sealed]]) {
    const start = performance.now(), result = await run();
    const elapsed = performance.now() - start;
    reference ??= result.content;
    assert.equal(result.content, reference);
    if (round >= 5) timing[label].push(elapsed);
  }
}
const stats = samples => {
  const sorted = [...samples].sort((a, b) => a - b);
  return { samples: samples.length, medianMs: sorted[Math.floor(sorted.length / 2)], minMs: sorted[0], maxMs: sorted.at(-1) };
};
console.log(JSON.stringify({ scope: 'Synthetic warm catalog only; not total agent latency or a production p95 gate',
  tools: count, responseBytes: Buffer.byteLength(reference), identicalResponses: true,
  repeatedDescriptors: stats(timing.repeatedDescriptors), sealedCache: stats(timing.sealedCache) }, null, 2));
