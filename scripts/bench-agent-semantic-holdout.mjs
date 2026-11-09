import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { captureReliabilitySource } from './reliability-source-manifest.ts';
const corpus = readFileSync('evals/agent-ide-reliability/semantic-holdout.json');
const entries = JSON.parse(corpus).entries;
const queries = entries.flatMap(([name, en, pt], index) => [
  { name, query: en, language: 'en', kind: 'concept' },
  { name, query: pt, language: 'pt-BR', kind: 'concept' },
  { name, query: `src/${name}.ts`, language: 'exact', kind: 'path' },
  { name, query: name, language: 'exact', kind: 'symbol' },
  { name: null, query: `AbsentHoldoutSymbol${index}DoesNotExist`, language: 'exact', kind: 'negative' },
]);
if (queries.length !== 200) throw new Error('Expected 200 labeled holdout queries');
const output = resolve('.tmp/agent-ide-reliability', `semantic-holdout-${Date.now()}`);
mkdirSync(output, { recursive: true });
const manifest = { at: new Date().toISOString(), corpusSha256: createHash('sha256').update(corpus).digest('hex'),
  source: captureReliabilitySource(resolve('.')), queries,
  scope: '40 authored TS behaviors in 10k-file fixture; independent queries, shared document distribution; API quality only' };
writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
const child = fork('scripts/fixtures/semantic-search-benchmark.ts', [], {
  execPath: createRequire(import.meta.url)('electron'), execArgv: ['--import', 'tsx'],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', RELIABILITY_RERANKER: 'off' },
  windowsHide: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
});
const exited = new Promise(resolve => child.once('exit', resolve));
let pending;
const ready = new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', code => reject(new Error(`fixture exited ${code}`)));
  child.on('message', message => { if (message.ready) resolve(message); else pending?.(message); });
});
const rows = [];
try {
  let startupTimer;
  const fixture = await Promise.race([ready, new Promise((_, reject) => {
    startupTimer = setTimeout(() => reject(new Error('holdout fixture startup timeout')), 60_000);
  })]).finally(() => clearTimeout(startupTimer));
  for (const mode of ['fts', 'auto']) for (const query of queries) {
    let timer;
    const reply = await Promise.race([
      new Promise(resolve => { pending = resolve; child.send({ id: rows.length, query: query.query, mode }); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('holdout query timeout')), 30_000); }),
    ]).finally(() => clearTimeout(timer));
    if (reply.error) throw new Error(reply.error);
    const hits = reply.result.results.map(hit => hit.data.file_path ?? hit.data.path);
    const rank = query.name === null ? null : hits.indexOf(`src/${query.name}.ts`) + 1;
    rows.push({ ...query, mode, rank, correct: query.name === null ? hits.length === 0 : rank > 0 && rank <= 10,
      ms: reply.ms, hits });
  }
  const summary = [];
  for (const mode of ['fts', 'auto']) for (const kind of ['concept', 'path', 'symbol', 'negative']) {
    for (const language of kind === 'concept' ? ['en', 'pt-BR'] : ['exact']) {
      const sample = rows.filter(r => r.mode === mode && r.kind === kind && r.language === language);
      summary.push({ mode, kind, language, n: sample.length, success: sample.filter(r => r.correct).length / sample.length,
        ...(kind === 'negative' ? {} : { ndcg10: sample.reduce((sum, row) =>
          sum + (row.rank > 0 && row.rank <= 10 ? 1 / Math.log2(row.rank + 1) : 0), 0) / sample.length }) });
    }
  }
  const sourceAfter = captureReliabilitySource(resolve('.'));
  const sourceStable = sourceAfter.sha256 === manifest.source.sha256;
  const failures = summary.filter(row => row.mode === 'auto' && row.success < (row.kind === 'concept' ? .9 : 1));
  writeFileSync(join(output, 'report.json'), JSON.stringify({ manifest, sourceAfter, sourceStable, failures, fixture: fixture.manifest, summary, rows }, null, 2));
  console.log(JSON.stringify({ output, summary }));
  if (!sourceStable) throw new Error('Source changed during the holdout run');
  if (failures.length) throw new Error('Holdout acceptance gates failed; inspect the preserved report');
} finally {
  if (child.connected) child.disconnect();
  const timer = setTimeout(() => child.kill(), 5000);
  await exited; clearTimeout(timer);
}
