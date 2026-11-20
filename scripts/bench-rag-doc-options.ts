/** Replay calibrated cutoffs and recorded search rewrites without a network request. */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { env } from '@huggingface/transformers';
import { CodeIndexDB } from '@mcp/store/db.js';
import { DocStore } from '@mcp/store/doc-store.js';
import { SqliteVecVectorStore } from '@mcp/store/sqlite-vec-store.js';
import { LocalEmbeddingService } from '@mcp/indexer/search/local-embeddings.js';
import { LocalReranker } from '@mcp/indexer/search/local-reranker.js';
import { DocHybridSearch } from '@mcp/services/services/docs/search.js';
import { CrossEncoderReranker } from '@mcp/services/services/docs/cross-encoder-reranker.js';
import type { QueryRewriter } from '@mcp/services/services/docs/query-rewriter.js';
import { aggregate, runOne, type GoldQuery, type QueryScore } from './docs-rag-evaluation.js';
if (!process.argv[2]) throw new Error('Pass an evidence run directory, optionally a live run directory');
const base = resolve(process.argv[2]), out = resolve('.tmp/agent-ide-reliability','doc-options-' + Date.now());
mkdirSync(out,{recursive:true});
process.env.MCP_DATA_DIR = join(base,'profile');
const cacheDir = join(homedir(),'.mcp','models');
env.allowRemoteModels = false;
env.localModelPath = cacheDir + '/';
const embedding = new LocalEmbeddingService({ cacheDir });
const reranker = new LocalReranker({ cacheDir, dtype:'fp32', strict:true, localFilesOnly:true });
const db = new CodeIndexDB(join(base,'index.db')), docs = new DocStore(db.raw());
const vectors = new SqliteVecVectorStore({ path:join(base,'vectors.db') });
try {
  const search = new DocHybridSearch(docs,embedding,vectors,undefined,{ reranker: new CrossEncoderReranker(reranker) });
  const { queries } = JSON.parse(readFileSync(join(base,'manifest.json'),'utf8')) as { queries: Array<GoldQuery & {kind:string;split:string}> };
  const rows: Array<QueryScore & { kind: string }> = [];
  for (const q of queries.filter(q => q.split === 'acceptance')) rows.push({ ...await runOne(search,'rerank',q), kind:q.kind });
  writeFileSync(join(out,'cutoffs.json'),JSON.stringify({ all:aggregate(rows), classes:Object.fromEntries(
    [...new Set(rows.map(r=>r.kind))].map(kind=>[kind,aggregate(rows.filter(r=>r.kind===kind))])) },null,2));
  if (process.argv[3]) {
    type Run = { topic:string;question:string;hasHistory:boolean;trace:Array<{tool:string;args:{query?:string}}> };
    const runs: Run[] = readFileSync(join(resolve(process.argv[3]),'tasks-planned.jsonl'),'utf8').trim().split(/\r?\n/).map(s=>JSON.parse(s));
    const report = [];
    for (const run of runs) {
      // Only use the first search formulated before observing any retrieval result.
      const generated = run.trace.find(call=>call.tool==='docs_search')?.args.query;
      if (!generated) throw new Error('No recorded first query for ' + run.topic);
      const rewritten = new DocHybridSearch(docs,embedding,vectors,undefined,{ rewriter: {
        rewrite:async(q:string)=>({ variants:[...new Set([q,generated])],llmUsed:false,cacheHit:true })
      } as unknown as QueryRewriter });
      const versions = ['current',run.hasHistory ? 'previous' : 'empty'];
      const collection_ids = versions.map(v=>docs.getCollectionByName(v)!.id);
      const expected = (run.hasHistory ? ['current','previous'] : ['current']).map(v=>'fixture://manual/'+v+'/'+run.topic+'.md');
      for (const [mode,engine] of [['original',search],['recorded',rewritten]] as const) {
        const { results,diag } = await engine.search({ query:run.question, collection_ids, limit:10, enhancements:{ rewrite:mode==='recorded' } });
        if (diag.vector_collections?.failed.length) throw new Error('Partial replay');
        const found = new Set(results.slice(0,5).map(r=>r.source_uri));
        report.push({ topic:run.topic,mode,targets:expected.length,found:expected.filter(id=>found.has(id)).length,variants:diag.rewrite_variants });
      }
    }
    writeFileSync(join(out,'rewrite.json'),JSON.stringify(report,null,2));
  }
  console.log(out);
} finally { await reranker.dispose(); await embedding.dispose(); vectors.close(); db.close(); }
