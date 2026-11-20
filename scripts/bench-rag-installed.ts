/** Evaluate the production project at its normal ten-result limit. */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { ProviderStore } from '@mcp/store/provider-store.js';
import { SemanticStore } from '@mcp/store/semantic-store.js';
import { LocalVectorRouter, LocalSemanticVectorStore } from '@mcp/store/local-vector-router.js';
import { codeNamespace } from '@mcp/shared/vector-namespace.js';
import { projectSemanticFolders } from '@mcp/shared/utils/semantic-folders.js';
import { HybridSearch } from '@mcp/indexer/search/hybrid.js';
import { SemanticProfileRuntime } from '@mcp/indexer/search/semantic-profile-runtime.js';
import { openNemotronBenchmark, embedModel, rerankModel, verifyNemotronRanking } from './bench-rag-openrouter.js';

if (!process.argv.includes('--openrouter-free')) throw new Error('Pass --openrouter-free to evaluate CodeStudio using its two configured free targets');
const root = realpathSync(process.cwd());
const dataDir = join(homedir(), '.mcp-code-indexer');
process.env.MCP_DATA_DIR = dataDir;
const output = resolve('.tmp/agent-ide-reliability', 'installed-' + Date.now());
mkdirSync(output, { recursive: true });
const db = new CodeIndexDB(join(dataDir, 'index.db'));
const store = new SemanticStore(db.raw());
const router = new LocalVectorRouter({ resolveProject: id => db.getProjectCatalogEntry(id), semanticStore: store, dataDir });
const runtime = new SemanticProfileRuntime(store, new ProviderStore(db.raw()));
const provider = openNemotronBenchmark(resolve('.tmp/agent-ide-reliability/nemotron-responses.db'));
try {
  const project = db.getProjectByName('CodeStudio/MCP-CodeBase');
  if (!project || realpathSync(project.root_path) !== root) throw new Error('Run this from the registered project root');
  const ns = codeNamespace(project.id), generation = store.getActiveGeneration(ns);
  const rankTarget = runtime.currentRerankerTarget('code', project.id);
  const target = generation?.embedding_target;
  if (!generation || target?.kind !== 'provider' || target.providerId !== 'openrouter' || target.model !== embedModel
    || target.inputFormat !== 'query-passage' || rankTarget.kind !== 'provider' || rankTarget.providerId !== 'openrouter'
    || rankTarget.model !== rerankModel || generation.dimension !== 2048) throw new Error('The requested Nemotron pair must be active');
  const physical = (await router.listIds(ns, generation.id)).length;
  const state = store.listNamespaceGenerations({ namespace: ns })[0];
  if (!physical || physical !== state?.expected_items || physical !== state.indexed_items || state.failed_items) throw new Error('Incomplete physical coverage');
  const vectors = new LocalSemanticVectorStore(router), encoder = runtime.queryEmbedding('code');
  const rrf = new HybridSearch(db, vectors, encoder);
  const hybrid = new HybridSearch(db, vectors, encoder, null, runtime.reranker('code', { strict: true }));
  type Label = { query: string; path: string; evidence: string; project?: 'indexer' | 'docs' };
  const roots = { indexer: 'packages/indexer/src/search', docs: 'packages/services/src/services/docs' };
  const results = [];
  for (const [split, file] of [['original', 'repository-queries'], ['holdout', 'code-project-holdout']] as const) {
    const gold = readFileSync('evals/rag/' + file + '.jsonl', 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line) as Label);
    for (const q of gold) {
      const path = q.project ? roots[q.project] + '/' + q.path : q.path;
      if (!readFileSync(join(root, path), 'utf8').includes(q.evidence)) throw new Error('Invalid evidence: ' + path);
      const screened = provider.wasScreened(q.query);
      const response = await (screened ? rrf : hybrid).searchWithDiag(project.id, project.name, q.query, { mode: 'hybrid', limit: 10, bypassCache: true });
      if (response.diagnostics.generationUsed !== generation.id) throw new Error('Generation changed during evaluation');
      const outcome = verifyNemotronRanking(response.diagnostics, screened);
      const rank = response.results.findIndex(hit => {
        const data = hit.data as { path?: string; file_path?: string };
        return (data.file_path ?? data.path)?.replaceAll('\\', '/') === path;
      }) + 1;
      results.push({ split, query: q.query, path, rank, outcome, ms: response.diagnostics.totalTimeMs });
    }
  }
  const hits = results.filter(row => row.rank > 0).length;
  const report = { project: project.name, namespace: ns, generation: generation.id, dimension: generation.dimension, folders: projectSemanticFolders(project),
    weight: project.semantic_vector_weight ?? 1, physical, hits, total: results.length, usage: provider.usage, results };
  writeFileSync(join(output, 'results.json'), JSON.stringify(report, null, 2));
  console.log(output, hits + '/' + results.length);
  if (results.filter(row => row.split === 'original' && row.rank > 0).length < 17) process.exitCode = 1;
} finally { provider.close(); await runtime.dispose(); router.close(); db.close(); }
