// Paired, isolated SQLite bootstrap benchmark. The compiled baseline must be
// captured before rebuilding dist; this does not certify application startup.
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Database } from '@mcp/store/db/types.js';
import { initSchema } from '@mcp/store/db/schema/index.js';

const output = process.argv[2];
if (!output) throw new Error('Expected an output report path');
const baselinePath = new URL('../dist/packages/store/src/db/schema/index.js', import.meta.url);
const candidatePath = new URL('../packages/store/src/db/schema/index.ts', import.meta.url);
const [baselineSource, candidateSource] = await Promise.all([readFile(baselinePath, 'utf8'), readFile(candidatePath, 'utf8')]);
if (baselineSource.includes('db.transaction')) throw new Error('Baseline already rebuilt; preserve the previous report instead of claiming a paired comparison');
const baseline = (await import(baselinePath.href)).initSchema as typeof initSchema;
const root = await mkdtemp(join(tmpdir(), 'codestudio-schema-benchmark-'));
const samples: { variant: string; iteration: number; elapsedMs: number; schemaHash: string; tableCount: number }[] = [];
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
try {
  for (let iteration = 0; iteration < 9; iteration++) {
    const variants = iteration % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
    for (const variant of variants) {
      const db = new Database(join(root, `${iteration}-${variant}.db`));
      try {
        db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL'); db.pragma('foreign_keys = ON');
        const started = performance.now();
        (variant === 'baseline' ? baseline : initSchema)(db);
        const elapsedMs = performance.now() - started;
        const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name").all();
        samples.push({ variant, iteration, elapsedMs, schemaHash: sha(JSON.stringify(schema)), tableCount: schema.length });
        if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Bootstrap integrity check failed');
      } finally { db.close(); }
    }
  }
  const stats = (variant: string) => {
    const values = samples.filter(sample => sample.variant === variant).map(sample => sample.elapsedMs).sort((a, b) => a - b);
    return { samples: values.length, medianMs: values[Math.floor(values.length / 2)], maximumMs: values.at(-1) };
  };
  const passed = new Set(samples.map(sample => sample.schemaHash)).size === 1;
  const report = { passed, scope: 'Fresh isolated SQLite schema bootstrap; WAL + FULL; alternating order. Not complete migrations or application startup.',
    platform: process.platform, versions: process.versions, baselineHash: sha(baselineSource), candidateHash: sha(candidateSource),
    baseline: stats('baseline'), candidate: stats('candidate'), samples };
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed, baseline: report.baseline, candidate: report.candidate }));
  if (!passed) throw new Error('Baseline and candidate schemas diverged');
} finally {
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('codestudio-schema-benchmark-')) throw new Error('Unsafe benchmark cleanup');
  await rm(root, { recursive: true, force: true });
}
