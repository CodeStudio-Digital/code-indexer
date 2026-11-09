/** Local-only retrieval ablation over authored, disposable multilingual source. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { cpus, totalmem } from 'node:os';
import { CodeIndexDB } from '@mcp/store/db.js';
import { runStructuralIndex } from '@mcp/indexer/indexer/structural.js';
import { buildScratchVectorStore } from '@mcp/indexer/benchmarks/scratch-index.js';
import { LocalEmbeddingService } from '@mcp/indexer/search/local-embeddings.js';
import { LocalReranker } from '@mcp/indexer/search/local-reranker.js';
import { HybridSearch } from '@mcp/indexer/search/hybrid.js';
import { recallAt, ndcgAt, isRelevant } from '@mcp/indexer/benchmarks/engine.js';

const output = resolve('.tmp/agent-ide-reliability', `retrieval-${Date.now()}`);
const root = join(output, 'project'); mkdirSync(root, { recursive: true });
process.env.MCP_DATA_DIR = join(output, 'profile');
mkdirSync(process.env.MCP_DATA_DIR, { recursive: true });
process.env.MCP_INDEX_WORKERS = '0';
const corpusFile = resolve('evals/agent-ide-reliability/semantic-fixtures.json');
const corpusBytes = readFileSync(corpusFile);
const corpus = JSON.parse(corpusBytes.toString()) as { entries: string[][] };
const paths = JSON.parse(readFileSync('evals/agent-ide-reliability/code-paths.json', 'utf8')) as { files: { path: string; symbol: string; language: string }[] };
type Query = { id: string; query: string; relevant_files: string[]; class: string; language: string; codeLanguage: string; split: string; wrongProject?: boolean };
const queries: Query[] = [];
for (const [index, [name, description, english, portuguese]] of corpus.entries.entries()) {
  const file = paths.files.find(file => file.symbol === name);
  if (!file) throw new Error(`Missing authored file mapping for ${name}`);
  const marker = `fixture_marker_${String(index).padStart(3, '0')}`;
  const body = file.language === 'cs'
    ? `// ${description}\npublic class ${name} { public static string Run() { return "${marker}"; } }\n`
    : file.language === 'php'
      ? `<?php\n// ${description}\nfunction ${name}() { return "${marker}"; }\n`
      : `// ${description}\nexport function ${name}(): string { return "${marker}"; }\n`;
  const target = join(root, file.path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, body);
  for (const [kind, query, language] of [['symbol', name, 'en'], ['literal', marker, 'en'], ['concept', english, 'en'], ['concept', portuguese, 'pt-BR'], ['wrong-project', name, 'en']]) {
    queries.push({ id: `${name}/${kind}/${language}`, query, class: kind, language, codeLanguage: file.language,
      split: index % 5 === 0 ? 'tuning' : 'acceptance', relevant_files: kind === 'wrong-project' ? [] : [file.path],
      ...(kind === 'wrong-project' ? { wrongProject: true } : {}) });
  }
}
writeFileSync(join(output, 'queries.json'), JSON.stringify(queries, null, 2));
writeFileSync(join(output, 'manifest.json'), JSON.stringify({ at: new Date().toISOString(), corpusSha256: createHash('sha256').update(corpusBytes).digest('hex'),
  scope: 'synthetic comment/body/symbol retrieval with real structural parser, sqlite-vec, FTS and local ONNX; excludes renderer, caller graph and production-scale semantic latency',
  files: corpus.entries.length, queries: queries.length, node: process.version, electron: process.versions.electron,
  cpu: cpus()[0]?.model, ram: totalmem(), embedding: 'Xenova/multilingual-e5-small:fp32', reranker: 'Xenova/bge-reranker-base:fp32',
  cache: 'bypassed per query', network: 'disabled', split: 'Every fifth authored topic is tuning; no score-dependent split changes' }, null, 2));

// Offline cached models only: a missing weight is an error, never a substitute model.
const transformers = await import('@huggingface/transformers');
transformers.env.allowRemoteModels = false;
const cacheDir = join(process.env.USERPROFILE ?? '', '.mcp', 'models');
transformers.env.localModelPath = cacheDir + '/';
const embedding = new LocalEmbeddingService({ cacheDir, dtype: 'fp32' });
const reranker = new LocalReranker({ cacheDir, dtype: 'fp32', strict: true });
const db = new CodeIndexDB(join(output, 'index.db'));
let vectors: Awaited<ReturnType<typeof buildScratchVectorStore>> | undefined;
try {
  const project = db.createProject('retrieval-fixture', root);
  const other = db.createProject('empty-project', join(output, 'other'));
  const indexed = await runStructuralIndex(db, project.id, { concurrency: 1 });
  if (indexed.errorCount || indexed.indexed !== corpus.entries.length) throw new Error(`Structural fixture failed: ${JSON.stringify(indexed)}`);
  const coldStart = performance.now();
  vectors = await buildScratchVectorStore(db, project, embedding, { scratchPath: join(output, 'vectors.db') });
  writeFileSync(join(output, 'index.json'), JSON.stringify({ ...indexed, semanticColdBuildMs: performance.now() - coldStart, embedded: vectors.embedded }, null, 2));
  const variants = [
    { name: 'fts', search: new HybridSearch(db, null, embedding), mode: 'fts' as const },
    { name: 'hybrid', search: new HybridSearch(db, vectors.store, embedding), mode: 'hybrid' as const },
    { name: 'reranked', search: new HybridSearch(db, vectors.store, embedding, null, reranker), mode: 'hybrid' as const },
  ];
  const rows: Array<Record<string, unknown>> = [];
  for (const [index, query] of queries.entries()) {
    // Alternating order avoids consistently assigning cold/host effects to one variant.
    for (const variant of index % 2 ? [...variants].reverse() : variants) {
      const start = performance.now();
      const { results, diagnostics } = await variant.search.searchWithDiag(query.wrongProject ? other.id : project.id,
        query.wrongProject ? other.name : project.name, query.query, { mode: variant.mode, limit: 10, bypassCache: true });
      if (variant.name !== 'fts' && (diagnostics.vectorError || diagnostics.rerankerError)) throw new Error(`Ablation degraded: ${JSON.stringify(diagnostics)}`);
      const rank = results.findIndex(result => isRelevant(result, query));
      rows.push({ id: query.id, variant: variant.name, class: query.class, language: query.language, codeLanguage: query.codeLanguage,
        split: query.split, ms: performance.now() - start, recall: query.relevant_files.length ? recallAt(results, query, 10) : null,
        ndcg: ndcgAt(results, query, 10), reciprocalRank: rank < 0 ? 0 : 1 / (rank + 1),
        negativeCorrect: query.relevant_files.length ? null : !results.length,
        results: results.map(result => result.data), diagnostics });
    }
    writeFileSync(join(output, 'metrics.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    console.log(`${index + 1}/${queries.length} ${query.id}`);
  }
  writeFileSync(join(output, 'summary.json'), JSON.stringify({ output, samples: rows.length,
    results: variants.map(variant => { const selected = rows.filter(row => row.variant === variant.name && row.split === 'acceptance');
      const positives = selected.filter(row => row.recall !== null), negatives = selected.filter(row => row.negativeCorrect !== null);
      return { variant: variant.name, recall: positives.reduce((sum, row) => sum + Number(row.recall), 0) / positives.length,
        negativeAccuracy: negatives.filter(row => row.negativeCorrect).length / negatives.length,
        conceptRecall: positives.filter(row => row.class === 'concept').reduce((sum, row) => sum + Number(row.recall), 0) / positives.filter(row => row.class === 'concept').length };
    }) }, null, 2));
  console.log(`Ablation complete: ${output}`);
} finally {
  await reranker.dispose(); await embedding.dispose();
  (vectors?.store as { close?: () => void } | undefined)?.close?.(); db.close();
}
