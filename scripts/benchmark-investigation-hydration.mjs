// Compare the old whole-project hydration with exact-ID reads on the same
// closed, isolated bundle. This measures local storage, not provider latency.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { FsSessionStore } from '../dist/packages/session-storage/src/fs-store/fs-session-store.js';

const root = await fs.mkdtemp(join(tmpdir(), 'codestudio-investigation-benchmark-'));
const projectRoot = join(root, 'project'); await fs.mkdir(projectRoot);
const store = FsSessionStore.fromRoots({ dataDir: join(root, 'data'), projectRootResolver: {
  resolveProjectRoot: id => id === 7 ? projectRoot : null, listProjectRoots: () => [{ project_id: 7, root_path: projectRoot }],
} });
const originalRead = fs.readFile;
let current;
try {
  const session = await store.createSession({ project_id: 7, title: 'Storage benchmark', provider: 'unused', model: 'unused' });
  const first = await store.recordInvestigation({ session_id: session.id, topic: 'fixture', summary: 'Summary', body: 'x'.repeat(16_000) });
  const location = await store.getSessionLocation(session.id), memoryRoot = join(location.bundle_path, 'memory');
  const template = JSON.parse(await fs.readFile(join(memoryRoot, first.id + '.json'), 'utf8'));
  const ids = [first.id], count = 1000;
  for (let offset = 1; offset < count; offset += 16) {
    await Promise.all(Array.from({ length: Math.min(16, count - offset) }, async (_, index) => {
      const id = randomUUID(); ids.push(id);
      await fs.writeFile(join(memoryRoot, id + '.json'), JSON.stringify({ ...template, id, seq: offset + index + 1 }));
    }));
  }
  const selected = ids.slice(500, 508).reverse();
  const old = async () => {
    const rows = await store.recallInvestigations(session.id, '', Number.MAX_SAFE_INTEGER);
    const byId = new Map(rows.map(row => [row.id, row])); return selected.map(id => byId.get(id));
  };
  const exact = () => store.recallInvestigationsByIds(session.id, selected, 8);
  fs.readFile = async (...args) => {
    const result = await originalRead(...args);
    if (current && String(args[0]).startsWith(memoryRoot)) {
      current.files++; current.bytes += typeof result === 'string' ? Buffer.byteLength(result) : result.byteLength;
    }
    return result;
  };
  syncBuiltinESMExports();
  const samples = { fullProject: [], exactIds: [] };
  let reference;
  for (let round = 0; round < 7; round++) {
    for (const [name, run] of round % 2 ? [['exactIds', exact], ['fullProject', old]] : [['fullProject', old], ['exactIds', exact]]) {
      current = { files: 0, bytes: 0 }; const start = performance.now();
      const value = await run(); const sample = { ...current, ms: performance.now() - start }; current = undefined;
      assert.equal(sample.files, name === 'exactIds' ? 8 : count, 'read instrumentation or query scope diverged');
      reference ??= value; assert.deepEqual(value, reference);
      if (round >= 2) samples[name].push(sample);
    }
  }
  const stats = values => ({ samples: values.length, medianMs: [...values].sort((a, b) => a.ms - b.ms)[Math.floor(values.length / 2)].ms,
    minMs: Math.min(...values.map(v => v.ms)), maxMs: Math.max(...values.map(v => v.ms)),
    filesPerRead: values.map(v => v.files), bytesPerRead: values.map(v => v.bytes) });
  console.log(JSON.stringify({ scope: 'Local synthetic hydration only; not production p95 or total agent latency',
    records: count, returned: selected.length, identicalResults: true, fullProject: stats(samples.fullProject), exactIds: stats(samples.exactIds) }, null, 2));
} finally {
  fs.readFile = originalRead; syncBuiltinESMExports(); await store.close();
  const rel = relative(resolve(tmpdir()), resolve(root));
  if (!rel || isAbsolute(rel) || rel.startsWith('..') || !rel.startsWith('codestudio-investigation-benchmark-')) throw new Error('Unsafe benchmark cleanup path');
  await fs.rm(root, { recursive: true, force: true });
}
