import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cpus, totalmem, platform, release } from 'node:os';
import { searchPaths } from '@mcp/store/db/files.js';
import { pathCandidates272 } from '@mcp/store/migrations/272-path-candidates.js';
import * as ranking from '@mcp/code-agent/tools/find-tools-score.js';

type Query = { id: string; split: string; class: string; language: string; query: string; projectId?: number; expected: string[] };
const corpusDir = resolve('evals/agent-ide-reliability');
const code = JSON.parse(readFileSync(resolve(corpusDir, 'code-paths.json'), 'utf8')) as { files: { path: string }[]; queries: Query[] };
const discovery = JSON.parse(readFileSync(resolve(corpusDir, 'discovery.json'), 'utf8')) as { tools: ranking.ToolLike[]; queries: Query[] };
const baselineRoot = resolve('.tmp/agent-ide-reliability/baseline');
if (!existsSync(baselineRoot)) throw new Error('Extract the recorded baseline with git archive before running the paired benchmark');
const baselinePaths = await import(pathToFileURL(resolve(baselineRoot, 'packages/store/src/db/files.ts')).href) as { searchPaths: typeof searchPaths };
const baselineRanking = await import(pathToFileURL(resolve(baselineRoot, 'packages/code-agent/src/tools/find-tools-score.ts')).href) as typeof ranking;
const Database = createRequire(import.meta.url)('better-sqlite3');
const output = resolve('.tmp/agent-ide-reliability/quality'); mkdirSync(output, { recursive: true });
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const manifest = { at: new Date().toISOString(), platform: platform(), release: release(), cpu: cpus()[0]?.model,
  logicalCpus: cpus().length, ram: totalmem(), node: process.version, electron: process.versions.electron, abi: process.versions.modules,
  baseline: '448d526dd2e24247617938721c0d8cf18ce850cf', baselinePathSource: sha(resolve(baselineRoot, 'packages/store/src/db/files.ts')),
  corpus: { code: sha(resolve(corpusDir, 'code-paths.json')), discovery: sha(resolve(corpusDir, 'discovery.json')) },
  scope: 'paired lexical path SQL and pure discovery ranking; excludes renderer, embeddings, authorization and activation', warmups: 10, samplesPerClassMinimum: 200 };
writeFileSync(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
type Row = { domain: string; size: number; variant: string; id: string; split: string; class: string; language: string; ms: number; recall: number | null; reciprocalRank: number; exactCorrect: boolean; negativeCorrect: boolean | null };
const rows: Row[] = [];
function record(domain: string, size: number, variant: string, query: Query, actual: string[], ms: number) {
  const rank = actual.findIndex(value => query.expected.includes(value));
  rows.push({ domain, size, variant, id: query.id, split: query.split, class: query.class, language: query.language, ms,
    recall: query.expected.length ? query.expected.filter(value => actual.includes(value)).length / query.expected.length : null,
    reciprocalRank: rank < 0 ? 0 : 1 / (rank + 1), exactCorrect: !query.expected.length || actual[0] === query.expected[0],
    negativeCorrect: query.expected.length ? null : actual.length === 0 });
}
for (const size of [1000, 10_000, 50_000, 150_000]) {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE files(id INTEGER PRIMARY KEY, project_id INTEGER, path TEXT, UNIQUE(project_id,path))');
    const insert = db.prepare('INSERT INTO files(project_id,path) VALUES(?,?)');
    db.transaction(() => {
      for (const file of code.files) insert.run(1, file.path);
      for (let i = code.files.length; i < size; i++) insert.run(1, `vendor/fixture-${String(i).padStart(7, '0')}.ts`);
      insert.run(2, 'other/Unrelated.ts');
    })();
    pathCandidates272.up(db);
    for (let warm = 0; warm < 10; warm++) { searchPaths(db, 1, code.queries[warm].query); baselinePaths.searchPaths(db, 1, code.queries[warm].query); }
    for (let repetition = 0; repetition < 10; repetition++) code.queries.forEach((query, index) => {
      for (const variant of index % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
        const start = performance.now();
        const actual = (variant === 'candidate' ? searchPaths : baselinePaths.searchPaths)(db, query.projectId!, query.query, 10).map(value => value.path);
        record('paths', size, variant, query, actual, performance.now() - start);
      }
    });
  } finally { db.close(); }
}
for (const size of [100, 500, 2000, 10_000]) {
  const tools = [...discovery.tools];
  while (tools.length < size) tools.push({ name: `synthetic_${tools.length}_zzcapability`, description: 'Synthetic distractor capability', parameters: { type: 'object', properties: { id: { type: 'string' } } } });
  const run = (query: string, candidate: boolean) => {
    const scorer = candidate ? ranking : baselineRanking;
    const tokens = scorer.tokenizeQuery(query);
    const scores = tools.map(tool => ({ name: tool.name, score: scorer.scoreTool(tokens, scorer.getToolText(tool)) }));
    if (candidate) return ranking.rankDiscoveryCandidates(query, scores, tokens.length).candidates.slice(0, 5).map(value => value.name);
    const strict = scores.filter(value => scorer.passesStrict(value.score, tokens.length, 0.5));
    return (strict.length ? strict : scores.filter(value => scorer.passesRelaxed(value.score, tokens.length, 0.5)))
      .sort((a, b) => b.score.total - a.score.total || Number(b.score.nameHit) - Number(a.score.nameHit) || a.name.localeCompare(b.name)).slice(0, 5).map(value => value.name);
  };
  for (let warm = 0; warm < 10; warm++) { run(discovery.queries[warm].query, true); run(discovery.queries[warm].query, false); }
  for (let repetition = 0; repetition < 10; repetition++) discovery.queries.forEach((query, index) => {
    for (const variant of index % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const start = performance.now(); const actual = run(query.query, variant === 'candidate');
      record('discovery', size, variant, query, actual, performance.now() - start);
    }
  });
}
const groups = new Map<string, Row[]>();
for (const row of rows) { const key = [row.domain, row.size, row.variant, row.split, row.class].join('/'); groups.set(key, [...groups.get(key) ?? [], row]); }
const summary = [...groups].map(([key, values]) => {
  const timings = values.map(row => row.ms).sort((a, b) => a - b), positives = values.filter(row => row.recall != null), negatives = values.filter(row => row.negativeCorrect != null);
  return { key, samples: values.length, p50Ms: timings[Math.floor(timings.length * 0.5)], p95Ms: timings[Math.floor(timings.length * 0.95)],
    recall: positives.length ? positives.reduce((sum, row) => sum + row.recall!, 0) / positives.length : null,
    mrr: positives.length ? positives.reduce((sum, row) => sum + row.reciprocalRank, 0) / positives.length : null,
    exactTop1: positives.length ? positives.filter(row => row.exactCorrect).length / positives.length : null,
    negatives: negatives.length ? negatives.filter(row => row.negativeCorrect).length / negatives.length : null };
});
writeFileSync(resolve(output, 'metrics.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
writeFileSync(resolve(output, 'summary.json'), JSON.stringify({ summary, rss: process.memoryUsage().rss }, null, 2));
console.log(JSON.stringify({ samples: rows.length, output, failures: summary.filter(row => row.key.includes('candidate') && ((row.recall != null && row.recall < .9) || (row.negatives != null && row.negatives < 1))) }, null, 2));
