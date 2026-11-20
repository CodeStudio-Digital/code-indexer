/** Summarize recorded runs offline. Arguments are the code, Docs and repository run directories, optionally the live run. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const [codeDir, docsDir, repoDir, liveDir, alternativesDir, contextDir] = process.argv.slice(2);
if (!repoDir) throw new Error('Pass the code, documentation and repository run directories');
const readRows = (dir, file) => readFileSync(join(dir, file), 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
const mean = values => values.length ? values.reduce((n, v) => n + v, 0) / values.length : null;
function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? null;
}
// Paired cluster bootstrap keeps translations and question variants within their authored topic.
function paired(a, b) {
  const delta = [];
  for (const [key, xs] of a) {
    const ys = b.get(key);
    assert.equal(ys?.length, xs.length, 'Missing paired questions for ' + key);
    delta.push(mean(ys) - mean(xs));
  }
  assert.equal(a.size, b.size);
  let state = 20261119;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 0x100000000);
  const samples = Array.from({ length: 10000 }, () => mean(delta.map(() => delta[Math.floor(random() * delta.length)])));
  return { groups: delta.length, difference: mean(delta), interval95: [quantile(samples, .025), quantile(samples, .975)] };
}
function summarize(rows, baseline) {
  const variants = new Map();
  for (const row of rows) {
    if (!variants.has(row.mode)) variants.set(row.mode, { recall: new Map(), ndcg: new Map(), latency: [], negatives: [] });
    const group = variants.get(row.mode);
    if (row.ms != null) group.latency.push(row.ms);
    if (row.negative != null) group.negatives.push(Number(row.negative));
    if (row.recall == null) continue;
    for (const metric of ['recall', 'ndcg']) {
      if (!group[metric].has(row.topic)) group[metric].set(row.topic, []);
      group[metric].get(row.topic).push(row[metric]);
    }
  }
  const summary = {};
  for (const [mode, set] of variants) {
    const reference = variants.get(baseline);
    const recall = [...set.recall.values()].flat();
    summary[mode] = { positives: recall.length, recall: mean(recall), ndcg: mean([...set.ndcg.values()].flat()),
      negatives: set.negatives.length, correctAbsences: set.negatives.reduce((a,b) => a+b,0),
      p50Ms: quantile(set.latency,.5), p95Ms: quantile(set.latency,.95), p99Ms: quantile(set.latency,.99),
      recallVsBaseline: paired(reference.recall,set.recall), ndcgVsBaseline: paired(reference.ndcg,set.ndcg) };
  }
  return summary;
}
const codeRows = rows => rows.filter(r => r.split === 'acceptance').map(r => ({
  topic: r.id.split('/')[0], mode: r.variant, ms: r.ms, recall: r.recall, ndcg: r.ndcg, negative: r.negativeCorrect }));
const readJson = (dir, file) => JSON.parse(readFileSync(join(dir,file),'utf8'));
const codeManifest = readJson(codeDir,'manifest.json'), docManifest = readJson(docsDir,'manifest.json');
const repoManifest = readJson(repoDir,'manifest.json');
const code = readRows(codeDir, 'metrics.jsonl'), documents = readRows(docsDir, 'docs.jsonl'), repository = readRows(repoDir, 'metrics.jsonl');
function checkMatrix(rows, modes, count, key) {
  assert.equal(rows.length, count * modes.length, 'Incomplete benchmark matrix');
  for (const mode of modes) {
    const selected = rows.filter(row => (row.variant ?? row.mode) === mode);
    assert.equal(selected.length, count, 'Missing rows for ' + mode);
    assert.equal(new Set(selected.map(key)).size, count, 'Duplicate examples in ' + mode);
  }
}
const codeModes = ['fts', 'vector', 'hybrid-no-graph', 'hybrid', 'reranked'];
checkMatrix(code, codeModes, codeManifest.queries, r => r.id);
checkMatrix(documents, ['fts', 'hybrid', 'rerank'], docManifest.queries.length, r => JSON.stringify([r.topic,r.kind]));
const repoModes = ['grep', 'fts', 'vector', 'hybrid', 'hybrid-lexical-graph', 'hybrid-seed-1-hop',
  'hybrid-seed-2-hop', 'rrf-file', 'normalized-file', 'reranked'];
const repoGold = readRows('evals/rag', 'repository-queries.jsonl');
checkMatrix(repository, repoModes, repoGold.length, r => JSON.stringify([r.project,r.query]));
for (const r of code.filter(r => r.recall !== null && r.variant !== 'fts')) {
  assert.ok(r.diagnostics?.vectorRawMatches > 0 && r.diagnostics?.vectorRehydrated > 0, 'Missing vector candidates: ' + r.id);
}
const report = {
  protocol: { codeBase: repoManifest.head, codeCorpusSha256: codeManifest.corpusSha256, docsTopicsSha256: docManifest.topicsSha256,
    repositoryGoldSha256: repoManifest.goldSHA, repositoryCorpora: repoManifest.projects.map(({ name, files, vectors, corpus }) =>
      ({ name, files, vectors, manifestSha256: createHash('sha256').update(JSON.stringify(corpus)).digest('hex') })),
    cpu: codeManifest.cpu?.trim(), node: codeManifest.node, electron: codeManifest.electron,
    embedding: codeManifest.embedding, device: readJson(codeDir, 'summary.json').embedding.executionProvider,
    bootstrapSamples: 10000, bootstrapSeed: 20261119 },
  executions: { code: code.length, docs: documents.length, repository: repository.length },
  code: summarize(codeRows(code), 'hybrid'),
  temporal: readJson(docsDir, 'temporal.json').summary,
  docs: summarize(documents.filter(r => r.split === 'acceptance').map(r => ({
    topic: r.topic, mode: r.mode, ms: r.elapsedMs, recall: r.positive ? r.recall5 : null, ndcg: r.ndcg10,
    negative: r.positive ? null : r.correctAbsence })), 'hybrid'),
  repository: summarize(repository.map(r => ({ topic: r.project + '/' + r.query, mode: r.variant,
    recall: Number(r.rank > 0 && r.rank <= 10), ndcg: r.rank > 0 && r.rank <= 10 ? 1 / Math.log2(1 + r.rank) : 0, ms: r.ms })), 'hybrid'),
};
const rerankPositives = code.filter(r => r.split === 'acceptance' && r.variant === 'reranked' && r.recall !== null);
report.code.reranked.appliedPositive = rerankPositives.filter(r => r.diagnostics.rerankerApplied).length;
report.code.reranked.skippedByReason = {};
for (const row of rerankPositives.filter(r => !r.diagnostics.rerankerApplied)) {
  const reason = row.diagnostics.rerankerSkippedReason;
  assert.ok(reason, 'No reason for skipping reranking: ' + row.id);
  report.code.reranked.skippedByReason[reason] = (report.code.reranked.skippedByReason[reason] ?? 0) + 1;
}
for (const mode of repoModes) {
  report.repository[mode].recallAt50 = mean(repository.filter(r => r.variant === mode).map(r => Number(r.rank > 0 && r.rank <= 50)));
}
if (alternativesDir) {
  const alternatives = readRows(alternativesDir, 'metrics.jsonl');
  checkMatrix(alternatives, ['granite','e5','no-content','recent-distractors','keywords'], codeManifest.queries, r => r.id);
  report.executions.alternatives = alternatives.length;
  report.alternatives = summarize(codeRows(alternatives), 'granite');
}
if (contextDir) report.context = readJson(contextDir, 'summary.json');
if (liveDir) {
  const topics = JSON.parse(readFileSync('evals/agent-ide-reliability/semantic-fixtures.json','utf8')).entries.map(t => t[0]);
  const live = {};
  for (const file of ['tasks.jsonl', 'tasks-planned.jsonl']) {
    const rows = readRows(liveDir, file);
    let cited = 0, relevant = 0, wanted = 0, validMarkers = 0, withAnswer = 0, high = 0;
    for (const row of rows) {
      const id = topics.indexOf(row.topic) + 1;
      assert.ok(id > 0);
      const expected = [id, ...(row.hasHistory ? [id + topics.length] : [])];
      wanted += expected.length;
      if (!row.payload) continue;
      withAnswer++;
      const ids = new Set(row.payload.chunks_cited);
      cited += ids.size;
      relevant += expected.filter(n => ids.has(n)).length;
      const markers = [...row.payload.markdown.matchAll(/\[\^(\d+)\]/g)].map(match => Number(match[1]));
      validMarkers += Number(markers.length > 0 && markers.every(n => n >= 1 && n <= ids.size));
      high += Number(row.payload.confidence === 'high');
    }
    live[file] = { tasks: rows.length, passed: rows.filter(row => row.pass).length, withAnswer, validMarkers, high,
      relevantCitations: relevant, allCitations: cited, expectedCitations: wanted,
      precision: relevant / cited, recall: relevant / wanted, p95Ms: quantile(rows.map(row => row.elapsedMs),.95) };
  }
  const receipts = new Map(readRows(liveDir, 'calls.jsonl').map(r => [r.id, r]));
  const charged = [...receipts.values()].filter(r => r.input != null && r.input > 0);
  live.usage = { meteredCalls: charged.length, input: charged.reduce((n,r) => n+r.input,0), output: charged.reduce((n,r) => n+r.output,0),
    estimatedUSD: charged.reduce((n,r) => n+r.charged,0) };
  report.live = live;
}
console.log(JSON.stringify(report, null, 2));
