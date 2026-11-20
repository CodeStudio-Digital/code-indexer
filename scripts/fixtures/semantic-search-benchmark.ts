/** Disposable medium-project fixture, real parser/FTS/ONNX/vec0, IPC to Playwright. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { CodeIndexDB } from '@mcp/store/db.js';
import { runStructuralIndex } from '@mcp/indexer/indexer/structural.js';
import { buildScratchVectorStore } from '@mcp/indexer/benchmarks/scratch-index.js';
import { LocalEmbeddingService } from '@mcp/indexer/search/local-embeddings.js';
import { LocalReranker } from '@mcp/indexer/search/local-reranker.js';
import { NullReranker } from '@mcp/indexer/search/reranker.js';
import { HybridSearch, verifySemanticRetrieval } from '@mcp/indexer/search/hybrid.js';
import { SqliteVecVectorStore } from '@mcp/store/sqlite-vec-store.js';
import { BUNDLED_EMBEDDING_TARGET } from '@mcp/shared/providers/bundled-semantic-model.js';

const reuse = process.env.RELIABILITY_SEMANTIC_FIXTURE;
const output = reuse ? resolve(reuse) : resolve('.tmp/agent-ide-reliability', `semantic-ui-${Date.now()}-${process.pid}`);
const confined = relative(resolve('.tmp/agent-ide-reliability'), output);
if (!confined || confined.startsWith('..') || isAbsolute(confined)) throw new Error('Fixture must be inside the evaluation directory');
const root = join(output, 'project');
mkdirSync(join(root, 'src'), { recursive: true });
process.env.MCP_DATA_DIR = join(output, 'profile');
mkdirSync(process.env.MCP_DATA_DIR, { recursive: true });
process.env.MCP_INDEX_WORKERS = '0';
const corpusBytes = readFileSync('evals/agent-ide-reliability/semantic-fixtures.json');
const corpus = JSON.parse(corpusBytes.toString()) as { entries: string[][] };
if (!reuse) for (const [name, description] of corpus.entries) {
  writeFileSync(join(root, 'src', `${name}.ts`), `// ${description}\nexport function ${name}(): string { return "${name}"; }\n`);
}
if (!reuse) for (let i = corpus.entries.length; i < 10_000; i++) {
  const name = `FixtureRecord${String(i).padStart(5, '0')}`;
  writeFileSync(join(root, 'src', `${name}.ts`), `// Returns the numeric fixture record identifier ${i}.\nexport function ${name}(): number { return ${i}; }\n`);
}
const transformers = await import('@huggingface/transformers');
transformers.env.allowRemoteModels = false;
const cacheDir = join(process.env.USERPROFILE!, '.mcp', 'models');
transformers.env.localModelPath = cacheDir + '/';
const embedding = new LocalEmbeddingService({ cacheDir });
const reranker = process.env.RELIABILITY_RERANKER === 'off'
  ? new NullReranker() : new LocalReranker({ cacheDir, dtype: 'fp32', strict: true });
const db = new CodeIndexDB(join(output, 'index.db'));
const project = reuse ? db.getProjectByName('semantic-ui-fixture')! : db.createProject('semantic-ui-fixture', root);
if (!project) throw new Error('Missing fixture project');
db.updateProject(project.id, { semantic_index_folders: JSON.stringify(['src']) });
const started = performance.now();
if (!reuse) {
  const indexed = await runStructuralIndex(db, project.id, { concurrency: 1 });
  if (indexed.errorCount || indexed.indexed !== 10_000) throw new Error(`Index incomplete: ${JSON.stringify(indexed)}`);
  console.log(`Indexed ${indexed.indexed} files; embedding all eligible content`);
}
const prior = reuse ? JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8')) : null;
if (prior && (prior.corpusSha256 !== createHash('sha256').update(corpusBytes).digest('hex') ||
    prior.files !== 10_000 || prior.embedded !== 20_000 || prior.fingerprint !== embedding.fingerprint())) {
  throw new Error('Fixture manifest or embedding fingerprint mismatch');
}
const vectors = reuse ? { store: new SqliteVecVectorStore({ path: join(output, 'vectors.db') }), embedded: prior.embedded }
  : await buildScratchVectorStore(db, project, embedding, { scratchPath: join(output, 'vectors.db'),
  onProgress: p => { if (p.current % 1000 === 0) console.log(`Embedded ${p.current}/${p.total}`); } });
const search = new HybridSearch(db, vectors.store, embedding, null, reranker);
const manifest = { output, pid: process.pid, files: 10_000, embedded: vectors.embedded, reused: !!reuse,
  ...(reuse ? { reopenMs: performance.now() - started, coldBuildMs: prior.coldBuildMs } : { coldBuildMs: performance.now() - started }),
  corpusSha256: createHash('sha256').update(corpusBytes).digest('hex'),
  corpus: '40 authored behavioral files plus 9960 generated numeric-record distractors, all structurally indexed and embedded',
  embedding: BUNDLED_EMBEDDING_TARGET, fingerprint: embedding.fingerprint(), inference: embedding.diagnostics(),
  reranker: reranker instanceof LocalReranker ? 'Xenova/bge-reranker-base:fp32' : reranker.name,
  node: process.version, electron: process.versions.electron, network: 'disabled' };
writeFileSync(join(output, reuse ? `reuse-${process.pid}.json` : 'manifest.json'), JSON.stringify(manifest, null, 2));
process.on('message', async (message: { id: number; query: string; mode?: 'fts' | 'auto' }) => {
  const start = performance.now();
  try {
    const result = await search.searchWithDiag(project.id, project.name, message.query, { mode: message.mode ?? 'auto', limit: 20, bypassCache: true,
      ...(process.env.RELIABILITY_SEARCH_TYPE === 'files' ? { type: 'files' as const } : {}) });
    if (result.diagnostics.plannedMode !== 'fts') verifySemanticRetrieval(result.diagnostics, true);
    process.send?.({ id: message.id, result, ms: performance.now() - start });
  } catch (error) { process.send?.({ id: message.id, error: String(error) }); }
});
process.on('disconnect', () => {
  void Promise.all([embedding.dispose(), reranker instanceof LocalReranker ? reranker.dispose() : undefined]).finally(() => {
    (vectors.store as { close?: () => void }).close?.(); db.close(); process.exit(0);
  });
});
process.send?.({ ready: true, manifest, queries: corpus.entries.flatMap(([name, , en, pt], index) =>
  [{ name, query: en, language: 'en', split: index % 5 ? 'acceptance' : 'tuning' },
    { name, query: pt, language: 'pt-BR', split: index % 5 ? 'acceptance' : 'tuning' }]) });
