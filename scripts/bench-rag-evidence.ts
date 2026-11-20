/** Local, reproducible evaluation of retrieval, temporal memory and citation tools. */
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { DocStore } from '@mcp/store/doc-store.js';
import { SqliteVecVectorStore } from '@mcp/store/sqlite-vec-store.js';
import { docNamespace } from '@mcp/shared/vector-namespace.js';
import { LocalEmbeddingService } from '@mcp/indexer/search/local-embeddings.js';
import { LocalReranker } from '@mcp/indexer/search/local-reranker.js';
import { runStructuralIndex } from '@mcp/indexer/indexer/structural.js';
import { DocHybridSearch, vectorIdForChunk } from '@mcp/services/services/docs/search.js';
import { CrossEncoderReranker } from '@mcp/services/services/docs/cross-encoder-reranker.js';
import { buildEmbeddingText } from '@mcp/services/services/docs/index-doc-use-case/utils.js';
import { aggregate, runOne, type GoldQuery, type Mode, type QueryScore } from './docs-rag-evaluation.js';
import { measureMemoryAndEvidence, type Topic } from './bench-rag-temporal.js';

const output = resolve('.tmp/agent-ide-reliability', 'evidence-' + Date.now());
const root = join(output, 'project');
for (const dir of [root, join(root, 'current'), join(output, 'profile')]) mkdirSync(dir, { recursive: true });
process.env.MCP_DATA_DIR = join(output, 'profile');
process.env.MCP_INDEX_WORKERS = '0';
const bytes = readFileSync(resolve('evals/agent-ide-reliability/semantic-fixtures.json'));
const { entries } = JSON.parse(bytes.toString()) as { entries: Topic[] };
const queries: Array<GoldQuery & { topic: string; kind: string; split: string }> = [];
for (const [index, [topic, , en, pt]] of entries.entries()) {
  const split = index % 5 === 0 ? 'tuning' : 'acceptance';
  for (const [kind, query] of [['identifier', topic], ['en', en], ['pt-BR', pt], ['absent', index % 2 ?
    'Qual é o preço mensal em euros para usar ' + topic + '?' : topic]]) {
    const empty = kind === 'absent' && index % 2 === 0;
    queries.push({ topic, kind, split, query, collection: empty ? 'empty' : 'current',
      relevant: kind === 'absent' ? [] : [{ source_uri_contains: '/current/' + topic + '.md' }] });
  }
}
const save = (file: string, data: unknown) => writeFileSync(join(output, file), JSON.stringify(data, null, 2));
save('manifest.json', { topicsSha256: createHash('sha256').update(bytes).digest('hex'), queries, versions: ['previous', 'current'],
  scope: 'Synthetic paired manuals, real SQLite, Granite and cross-encoder. Deterministic tool execution without text generation.' });
const cacheDir = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.mcp', 'models');
const { env } = await import('@huggingface/transformers');
env.allowRemoteModels = false;
env.localModelPath = cacheDir + '/';
const embedding = new LocalEmbeddingService({ cacheDir });
const reranker = new LocalReranker({ cacheDir, dtype: 'fp32', localFilesOnly: true, strict: true });
const db = new CodeIndexDB(join(output, 'index.db'));
const vectors = new SqliteVecVectorStore({ path: join(output, 'vectors.db') });
try {
  const docs = new DocStore(db.raw());
  const project = db.createProject('current-project', root);
  const other = db.createProject('other-project', join(output, 'other'));
  for (const [topic] of entries) writeFileSync(join(root, topic + '.ts'), 'export function ' + topic + '() { return 1; }\n');
  const before = await runStructuralIndex(db, project.id, { concurrency: 1 });
  for (const [topic] of entries) renameSync(join(root, topic + '.ts'), join(root, 'current', topic + '.ts'));
  const moved = await runStructuralIndex(db, project.id, { concurrency: 1 });
  if (before.indexed !== entries.length || moved.indexed !== entries.length || moved.errorCount || before.errorCount) {
    throw new Error('Failed to build and move the fixture symbols');
  }
  const ids = new Map<string, number>();
  for (const version of ['previous', 'current', 'empty']) {
    const collection = docs.createCollection({ name: version });
    if (version === 'empty') continue;
    const rows = entries.map(([topic, description]) => {
      const uri = 'fixture://manual/' + version + '/' + topic + '.md';
      const source = docs.createSource({ collection_id: collection.id, type: 'url', uri });
      const path = (version === 'current' ? 'current/' : '') + topic + '.ts';
      const content = description + '\nImplementation path: ' + path + '.\nDecision: ' +
        (version === 'current' ? 'validate before publishing.' : 'publish before validation.');
      const [id] = docs.insertChunks([{ source_id: source.id, collection_id: collection.id, ord: 0, heading_path: topic,
        content, content_hash: createHash('sha256').update(content).digest('hex'), source_uri: uri, anchor: topic.toLowerCase() }]);
      ids.set(version + '/' + topic, id!);
      return { id: id!, text: buildEmbeddingText(topic, null, content) };
    });
    for (let start = 0; start < rows.length; start += 8) {
      const batch = rows.slice(start, start + 8);
      const encoded = await embedding.embed(batch.map(row => row.text));
      if (encoded.vectors.length !== batch.length) throw new Error('Incomplete document embedding batch');
      await vectors.upsert(batch.map((row, i) => ({ id: vectorIdForChunk(row.id), values: encoded.vectors[i]!,
        metadata: { type: 'doc_chunk', chunk_id: String(row.id), corpus: 'docs' } })), docNamespace(collection.id));
    }
  }
  const search = new DocHybridSearch(docs, embedding, vectors, undefined, { reranker: new CrossEncoderReranker(reranker) });
  const temporal = await measureMemoryAndEvidence(db, docs, search, entries, ids, project.id, other.id);
  save('temporal.json', temporal);
  console.log('Memory and agent-tool runs complete at ' + output);
  const rows: Array<QueryScore & { topic: string; kind: string; split: string }> = [];
  const modes: Mode[] = ['fts', 'hybrid', 'rerank'];
  for (const [index, q] of queries.entries()) {
    for (const mode of index % 2 ? [...modes].reverse() : modes) {
      const row = { ...await runOne(search, mode, q), topic: q.topic, kind: q.kind, split: q.split };
      if (row.vectorCollections?.failed.length) throw new Error('Vector search failed for ' + q.topic);
      rows.push(row);
      appendFileSync(join(output, 'docs.jsonl'), JSON.stringify(row) + '\n');
    }
    if ((index + 1) % 10 === 0) console.log((index + 1) + '/' + queries.length + ' documents');
  }
  const acceptance = rows.filter(row => row.split === 'acceptance');
  save('summary.json', { embedding: embedding.diagnostics(), modes: Object.fromEntries(modes.map(mode =>
    [mode, aggregate(acceptance.filter(row => row.mode === mode))])), temporal: temporal.summary });
  if (!rows.some(row => row.reranked)) throw new Error('No cross-encoder inference in the requested comparison');
  console.log('Evidence benchmark complete at ' + output);
} finally {
  await reranker.dispose();
  await embedding.dispose();
  vectors.close();
  db.close();
}
