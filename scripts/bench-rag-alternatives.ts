/** Paired local ablations over a previously built synthetic code corpus. */
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { env } from '@huggingface/transformers';
import { CodeIndexDB } from '@mcp/store/db.js';
import { SqliteVecVectorStore } from '@mcp/store/sqlite-vec-store.js';
import { buildScratchVectorStore } from '@mcp/indexer/benchmarks/scratch-index.js';
import { recallAt, ndcgAt, type EvalQuery } from '@mcp/indexer/benchmarks/engine.js';
import { LocalEmbeddingService } from '@mcp/indexer/search/local-embeddings.js';
import { HybridSearch, verifySemanticRetrieval } from '@mcp/indexer/search/hybrid.js';
import type { HyDEService } from '@mcp/indexer/search/hyde.js';
import { RecentFilesSource } from '@mcp/indexer/search/recent-files-source.js';

type Query = EvalQuery & { id: string; split: string; class: string; language: string; wrongProject?: boolean };
if (!process.argv[2]) throw new Error('Pass a completed bench-agent-retrieval run directory');
const base = resolve(process.argv[2]), output = resolve('.tmp/agent-ide-reliability','alternatives-' + Date.now());
mkdirSync(output, { recursive: true });
process.env.MCP_DATA_DIR = join(base, 'profile');
const cacheDir = join(homedir(), '.mcp', 'models');
env.allowRemoteModels = false;
env.localModelPath = cacheDir + '/';
const granite = new LocalEmbeddingService({ cacheDir }), alternative = new LocalEmbeddingService({
  model: 'Xenova/multilingual-e5-small', dtype: 'fp32', cacheDir });
const queries: Query[] = JSON.parse(readFileSync(join(base,'queries.json'),'utf8'));
const db = new CodeIndexDB(join(base, 'index.db'));
const project = db.getProjectByName('retrieval-fixture')!, empty = db.getProjectByName('empty-project')!;
if (!project || !empty || resolve(project.root_path) !== join(base, 'project')) throw new Error('Expected the synthetic retrieval fixture');
for (const fixture of [project, empty]) db.updateProject(fixture.id, { semantic_index_folders: JSON.stringify(['.']) });
const vectors = new SqliteVecVectorStore({ path: join(base, 'vectors.db') });
const altPath = join(output, 'e5-vectors.db'), start = performance.now();
let scratch: Awaited<ReturnType<typeof buildScratchVectorStore>> | undefined;
try {
  scratch = await buildScratchVectorStore(db, project, alternative, { scratchPath: altPath });
  const buildMs = performance.now() - start;
  const rows: Array<{ variant: string; split: string; recall: number | null; ndcg: number }> = [];
  const files = db.listFiles(project.id);
  const primary = new HybridSearch(db, vectors, granite), e5 = new HybridSearch(db, scratch.store, alternative);
  // Fixed, query-only expansion. The lookup labels never enter this rewriter.
  const keywords = { generate: async (query: string) => query.replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase().replace(/\b(where|what|which|how|does|the|of|em|que|como|onde|qual|uma|com)\b/g, ' ').replace(/[^\p{L}\p{N}_]+/gu, ' ').trim() };
  const expanded = new HybridSearch(db, vectors, granite, keywords as unknown as HyDEService);
  for (const [index,q] of queries.entries()) {
    const target = q.wrongProject ? empty : project;
    const recent = new RecentFilesSource(), words = q.query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
    const distractors = files.filter(f => !q.relevant_files?.includes(f.path)).map(file => ({
      file, overlap: words.filter(word => file.path.toLowerCase().includes(word)).length }))
      .sort((a,b) => b.overlap - a.overlap || a.file.path.localeCompare(b.file.path)).slice(0, 3);
    for (const { file } of distractors) recent.touch({ projectId: project.id, fileId: file.id, filePath: file.path, kind: 'view' });
    const runs = [
      ['granite', primary, true], ['e5', e5, true], ['no-content', primary, false],
      ['recent-distractors', new HybridSearch(db,vectors,granite,null,null,recent), true], ['keywords', expanded, true],
    ] as const;
    for (const [variant, search, content] of index % 2 ? [...runs].reverse() : runs) {
      process.env.MCP_FTS_CONTENT_STREAM = content ? '1' : '0';
      const t = performance.now();
      const { results, diagnostics: d } = await search.searchWithDiag(target.id, target.name, q.query, { mode: 'hybrid', limit: 10, bypassCache: true });
      verifySemanticRetrieval(d, !q.wrongProject);
      const row = { id:q.id, variant, split:q.split, class:q.class, language:q.language, ms:performance.now()-t,
        recall:q.wrongProject ? null : recallAt(results,q,10), ndcg:ndcgAt(results,q,10), negativeCorrect:q.wrongProject ? !results.length : null,
        variants:d.queryVariants, recent:d.recentFilesCount, content:d.contentCount };
      rows.push(row);
      appendFileSync(join(output,'metrics.jsonl'),JSON.stringify(row) + '\n');
    }
  }
  writeFileSync(join(output, 'summary.json'), JSON.stringify({ base, output, rows: rows.length, granite: granite.diagnostics(),
    alternative: alternative.diagnostics(), e5BuildMs: buildMs,
    e5VectorBytes: statSync(altPath).size + (statSync(altPath + '-wal', { throwIfNoEntry: false })?.size ?? 0), e5Vectors: scratch.embedded,
    results: Object.fromEntries(['granite','e5','no-content','recent-distractors','keywords'].map(variant => {
      const pos = rows.filter(x => x.variant === variant && x.split === 'acceptance' && x.recall != null);
      return [variant, { n: pos.length, recall: pos.reduce((n,x)=>n+x.recall!,0)/pos.length, ndcg: pos.reduce((n,x)=>n+x.ndcg,0)/pos.length }];
    })) }, null, 2));
  console.log(output);
} finally {
  (scratch?.store as { close?: () => void } | undefined)?.close?.();
  await alternative.dispose(); await granite.dispose(); vectors.close(); db.close();
}
