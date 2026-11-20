/** Paired file-level comparisons on two complete source subtrees, including their tests. */
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { runStructuralIndex } from '@mcp/indexer/indexer/structural.js';
import { buildScratchVectorStore } from '@mcp/indexer/benchmarks/scratch-index.js';
import { HybridSearch, verifySemanticRetrieval } from '@mcp/indexer/search/hybrid.js';
import { LocalEmbeddingService } from '@mcp/indexer/search/local-embeddings.js';
import { LocalReranker } from '@mcp/indexer/search/local-reranker.js';
import { expandGraph } from '@mcp/indexer/search/graph-expansion-source.js';
import type { HybridSearchResult } from '@mcp/shared/types.js';

type Hit = { path: string; score: number };
function files(items: HybridSearchResult[]): Hit[] {
  const seen = new Set<string>(), out: Hit[] = [];
  for (const hit of items) {
    const data = hit.data as { path?: string; file_path?: string };
    const path = (data.file_path ?? data.path)?.replaceAll('\\', '/');
    if (path && !seen.has(path)) { seen.add(path); out.push({ path, score: hit.score }); }
  }
  return out;
}
function fuse(lists: Hit[][], normalized: boolean): Hit[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    const values = list.map(hit => hit.score);
    const min = Math.min(...values), max = Math.max(...values);
    for (const [rank, hit] of list.entries()) {
      const score = normalized ? (max === min ? 1 : (hit.score - min) / (max - min)) : 1 / (61 + rank);
      scores.set(hit.path, (scores.get(hit.path) ?? 0) + score);
    }
  }
  return [...scores].map(([path, score]) => ({ path, score })).sort((a, b) => b.score - a.score);
}
const output = resolve('.tmp/agent-ide-reliability', 'repository-' + Date.now());
mkdirSync(join(output, 'profile'), { recursive: true });
process.env.MCP_DATA_DIR = join(output, 'profile');
process.env.MCP_INDEX_WORKERS = '0';
const gold = readFileSync('evals/rag/repository-queries.jsonl', 'utf8').trim().split(/\r?\n/).map(line =>
  JSON.parse(line) as { project: string; kind: string; query: string; path: string; evidence: string });
const roots = { indexer: 'packages/indexer/src/search', docs: 'packages/services/src/services/docs' };
for (const row of gold) {
  const root = roots[row.project as keyof typeof roots];
  if (!root || !readFileSync(join(root, row.path), 'utf8').includes(row.evidence)) throw new Error('Invalid gold evidence: ' + row.path);
}
const { env } = await import('@huggingface/transformers');
env.allowRemoteModels = false;
const cacheDir = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.mcp', 'models');
env.localModelPath = cacheDir + '/';
const embedding = new LocalEmbeddingService({ cacheDir });
const reranker = new LocalReranker({ cacheDir, dtype: 'fp32', strict: true, localFilesOnly: true });
const db = new CodeIndexDB(join(output, 'index.db'));
const manifest = { head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), roots,
  goldSHA: createHash('sha256').update(JSON.stringify(gold)).digest('hex'), projects: [] as object[] };
const rows: Array<{ project: string; kind: string; query: string; variant: string; rank: number; candidateCount: number }> = [];
try {
  for (const [name, dir] of Object.entries(roots)) {
    const project = db.createProject(name, resolve(dir));
    db.updateProject(project.id, { semantic_index_folders: JSON.stringify(['.']) });
    const start = performance.now();
    const structure = await runStructuralIndex(db, project.id);
    if (structure.errorCount || structure.unavailableRoots?.length) throw new Error('Incomplete structural index: ' + name);
    const path = join(output, name + '.db');
    const scratch = await buildScratchVectorStore(db, project, embedding, { scratchPath: path });
    try {
      manifest.projects.push({ name, files: scratch.files, vectors: scratch.embedded,
        bytes: statSync(path).size + (statSync(path + '-wal', { throwIfNoEntry: false })?.size ?? 0),
        buildMs: performance.now() - start, corpus: db.listFiles(project.id).map(f => [f.path, f.content_hash]) });
      const engine = new HybridSearch(db, scratch.store, embedding);
      const ranked = new HybridSearch(db, scratch.store, embedding, null, reranker);
      for (const q of gold.filter(row => row.project === name)) {
        const latency: Record<string, number> = {};
        const run = async (mode: 'hybrid' | 'vector' | 'fts', graph: boolean, rerank = false) => {
          process.env.MCP_PIPELINES_GRAPH_EXPANSION = graph ? '1' : '0';
          const started = performance.now();
          const result = await (rerank ? ranked : engine).searchWithDiag(project.id, name, q.query, { mode, limit: 50, bypassCache: true });
          latency[rerank ? 'reranked' : graph ? 'hybrid-lexical-graph' : mode] = performance.now() - started;
          if (mode !== 'fts') verifySemanticRetrieval(result.diagnostics, true);
          return result.results;
        };
        const fts = files(await run('fts', false)), vec = files(await run('vector', false));
        const primary = await run('hybrid', false), hybrid = files(primary);
        const graphStart = performance.now();
        const one = expandGraph(db, project.id, primary.slice(0, 5), 'all', { maxResults: 15 });
        const firstHopMs = performance.now() - graphStart;
        const two = expandGraph(db, project.id, one.slice(0, 5), 'all', { maxResults: 15 });
        const bothHopsMs = performance.now() - graphStart;
        const grepStart = performance.now();
        const grep = spawnSync('rg', ['-i', '-l', '--fixed-strings', '--sort', 'path', '--', q.query, '.'],
          { cwd: resolve(dir), windowsHide: true, encoding: 'utf8' });
        if (grep.error || (grep.status !== 0 && grep.status !== 1)) throw grep.error ?? new Error(grep.stderr);
        latency.grep = performance.now() - grepStart;
        const merge = (label: string, upstreamMs: number, inputs: Parameters<typeof fuse>[0], normalized = false) => {
          const started = performance.now();
          const merged = fuse(inputs, normalized);
          latency[label] = upstreamMs + performance.now() - started;
          return merged;
        };
        const variants = {
          grep: grep.stdout.trim().split(/\r?\n/).filter(Boolean).map(p => ({ path: p.replaceAll('\\', '/').replace(/^\.\//, ''), score: 1 })),
          fts, vector: vec, hybrid, 'hybrid-lexical-graph': files(await run('hybrid', true)),
          'hybrid-seed-1-hop': merge('hybrid-seed-1-hop', latency.hybrid! + firstHopMs, [hybrid, files(one)]),
          'hybrid-seed-2-hop': merge('hybrid-seed-2-hop', latency.hybrid! + bothHopsMs, [hybrid, files(one), files(two)]),
          'rrf-file': merge('rrf-file', latency.fts! + latency.vector!, [fts, vec]),
          'normalized-file': merge('normalized-file', latency.fts! + latency.vector!, [fts, vec], true),
          reranked: files(await run('hybrid', true, true)),
        };
        for (const [variant, hits] of Object.entries(variants)) {
          const result = { project: name, kind: q.kind, query: q.query, variant,
            rank: hits.findIndex(h => h.path === q.path) + 1, candidateCount: hits.length, ms: latency[variant] };
          rows.push(result);
          appendFileSync(join(output, 'metrics.jsonl'), JSON.stringify(result) + '\n');
        }
        console.log(name + ' ' + q.query);
      }
    } finally { (scratch.store as { close?: () => void }).close?.(); }
  }
  writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest));
  const summary = Object.fromEntries([...new Set(rows.map(r => r.variant))].map(v => {
    const group = rows.filter(r => r.variant === v);
    return [v, { total: group.length, hits10: group.filter(r => r.rank > 0 && r.rank <= 10).length,
      ndcg10: group.reduce((sum, r) => sum + (r.rank > 0 && r.rank <= 10 ? 1 / Math.log2(1 + r.rank) : 0), 0) / group.length }];
  }));
  writeFileSync(join(output, 'summary.json'), JSON.stringify({ embedding: embedding.diagnostics(), summary }, null, 2));
  console.log(output);
} finally { await embedding.dispose(); await reranker.dispose(); db.close(); }
