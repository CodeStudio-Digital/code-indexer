/**
 * Doc-RAG retrieval-quality benchmark.
 *
 * Runs a labeled gold-set of queries against the REAL indexed doc corpus and
 * reports R@5 / nDCG@10 / MRR per mode (fts vs hybrid vs hybrid+rerank) and per
 * doc_type — so you can prove the reranker default actually helps and spot
 * regressions per documentation kind.
 *
 * Prereq: a populated doc corpus (Documentação feature) in the live DB, and
 * `pnpm node:rebuild` so better-sqlite3 matches Node (run with the app closed).
 *
 * Usage:
 *   tsx scripts/docs-rag-eval.ts --file path/to/gold-set.jsonl
 *   tsx scripts/docs-rag-eval.ts --file gold.jsonl --modes fts,hybrid,rerank
 *   tsx scripts/docs-rag-eval.ts --file gold.jsonl --min-recall 0.7 --gate-mode rerank
 *
 * Gold-set format (JSONL, one query/line) — see
 * packages/services/src/services/docs/__tests__/eval/gold-set.example.jsonl:
 *   {"query":"How does Rigidbody.AddForce work?","doc_type":"api_reference",
 *    "collection":"unity-docs","relevant":[{"source_uri_contains":"ScriptReference/Rigidbody.AddForce"}]}
 *
 * Relevance is matched by source_uri / heading substring (NOT chunk_id), so the
 * gold-set survives re-indexing.
 */
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { loadConfig } from '@mcp/shared/utils/config.js';
import { CodeIndexDB } from '@mcp/store/db.js';
import { ProviderStore } from '@mcp/store/provider-store.js';
import { DocStore } from '@mcp/store/doc-store.js';
import { createEmbeddingService } from '@mcp/indexer/search/embeddings.js';
import { createVectorStore, NullVectorStore } from '@mcp/store/vectors.js';
import { createReranker } from '@mcp/indexer/search/reranker.js';
import { DocHybridSearch, CrossEncoderReranker } from '@mcp/services/services/docs/index.js';
import {
  labelRanked,
  successAtK,
  recallAtK,
  ndcgAtK,
  mrr,
  mean,
  type RelevantSpec,
} from '@mcp/services/services/docs/eval-metrics.js';

type Mode = 'fts' | 'hybrid' | 'rerank';

interface GoldQuery {
  query: string;
  doc_type?: string;
  collection?: string;
  relevant: RelevantSpec[];
}

interface QueryScore {
  mode: Mode;
  doc_type: string;
  success5: number;
  recall5: number;
  ndcg10: number;
  rr: number;
}

const LIMIT = 10;

function parseGold(path: string): GoldQuery[] {
  const out: GoldQuery[] = [];
  for (const line of readFileSync(path, 'utf-8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    try {
      const q = JSON.parse(t) as GoldQuery;
      // Each `relevant` entry = ONE distinct expected document; skip queries
      // with none (they'd score 0 across the board and skew the averages).
      if (q.query && Array.isArray(q.relevant) && q.relevant.length > 0) out.push(q);
    } catch (e) {
      console.error(`[docs-eval] skipping malformed line: ${(e as Error).message}`);
    }
  }
  return out;
}

async function runOne(search: DocHybridSearch, mode: Mode, q: GoldQuery): Promise<QueryScore> {
  const input = {
    query: q.query,
    collection: q.collection,
    limit: LIMIT,
    ...(mode === 'fts' ? { mode: 'fts' as const } : {}),
    ...(mode === 'rerank' ? { enhancements: { rerank: true, top_k_for_rerank: 20 } } : {}),
  };
  const { results } = await search.search(input);
  const ranked = labelRanked(
    results.map((r) => ({ source_uri: r.source_uri, heading_path: r.heading_path })),
    q.relevant,
  );
  const n = q.relevant.length;
  return {
    mode,
    doc_type: q.doc_type ?? '(untyped)',
    success5: successAtK(ranked, 5),
    recall5: recallAtK(ranked, 5, n),
    ndcg10: ndcgAtK(ranked, 10, n),
    rr: mrr(ranked),
  };
}

function aggregate(rows: QueryScore[]): { recall5: number; success5: number; ndcg10: number; mrr: number; n: number } {
  return {
    recall5: mean(rows.map((r) => r.recall5)),
    success5: mean(rows.map((r) => r.success5)),
    ndcg10: mean(rows.map((r) => r.ndcg10)),
    mrr: mean(rows.map((r) => r.rr)),
    n: rows.length,
  };
}

function printTable(title: string, rows: Array<{ label: string; recall5: number; success5: number; ndcg10: number; mrr: number; n: number }>): void {
  console.log(`\n${title}`);
  const header = ['group', 'R@5', 'S@5', 'nDCG@10', 'MRR', 'N'];
  const cells = rows.map((r) => [r.label, r.recall5.toFixed(3), r.success5.toFixed(3), r.ndcg10.toFixed(3), r.mrr.toFixed(3), String(r.n)]);
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i]!.length)));
  const pad = (s: string, w: number) => s.padEnd(w, ' ');
  console.log(header.map((h, i) => pad(h, widths[i]!)).join('  '));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const c of cells) console.log(c.map((v, i) => pad(v, widths[i]!)).join('  '));
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      file: { type: 'string' },
      modes: { type: 'string' },
      'min-recall': { type: 'string' },
      'gate-mode': { type: 'string' },
    },
  });
  if (!values.file) {
    console.error('Usage: tsx scripts/docs-rag-eval.ts --file <gold-set.jsonl> [--modes fts,hybrid,rerank] [--min-recall 0.7] [--gate-mode rerank]');
    process.exit(1);
  }
  const modes = (values.modes?.split(',') as Mode[]) ?? ['fts', 'hybrid', 'rerank'];
  const gold = parseGold(values.file);
  if (gold.length === 0) {
    console.error('[docs-eval] gold-set is empty');
    process.exit(1);
  }

  const config = loadConfig();
  const db = new CodeIndexDB(config.dbPath);
  const providerStore = new ProviderStore(config.dbPath);
  providerStore.seedFromEnvIfEmpty();
  const docStore = new DocStore(db.raw());
  const embeddingService = createEmbeddingService(providerStore);
  const vectorStore = createVectorStore(providerStore);
  // NullVectorStore (no vector backend configured) → null so hybrid skips the
  // vector leg entirely instead of querying a no-op store (matches the code
  // bench wiring in src/benchmarks/search-quality.ts).
  const searchable = vectorStore instanceof NullVectorStore ? null : vectorStore;
  const reranker = new CrossEncoderReranker(createReranker(providerStore));
  const search = new DocHybridSearch(docStore, embeddingService, searchable, undefined, { reranker });

  console.log(`[docs-eval] queries=${gold.length} modes=${modes.join(',')} reranker=${reranker ? 'cross-encoder' : 'none'}`);

  const all: QueryScore[] = [];
  for (const mode of modes) {
    process.stdout.write(`  running ${mode}… `);
    const t0 = Date.now();
    for (const q of gold) {
      try {
        all.push(await runOne(search, mode, q));
      } catch (e) {
        console.error(`\n  [${mode}] "${q.query}" failed: ${(e as Error).message}`);
      }
    }
    console.log(`done (${Date.now() - t0}ms)`);
  }

  // Overall per mode.
  printTable(
    'Overall by mode',
    modes.map((m) => ({ label: m, ...aggregate(all.filter((r) => r.mode === m)) })),
  );

  // Per doc_type × mode.
  const docTypes = [...new Set(gold.map((q) => q.doc_type ?? '(untyped)'))].sort();
  for (const dt of docTypes) {
    printTable(
      `doc_type=${dt}`,
      modes.map((m) => ({ label: m, ...aggregate(all.filter((r) => r.mode === m && r.doc_type === dt)) })),
    );
  }

  // Optional CI gate.
  const minRecall = values['min-recall'] !== undefined ? Number(values['min-recall']) : NaN;
  if (Number.isFinite(minRecall)) {
    const gateMode = (values['gate-mode'] as Mode) ?? modes[modes.length - 1]!;
    const r5 = aggregate(all.filter((r) => r.mode === gateMode)).recall5;
    console.log(`\n[gate] ${gateMode} R@5=${r5.toFixed(3)} (min ${minRecall})`);
    if (r5 < minRecall) {
      console.error('[gate] FAILED — retrieval recall below threshold');
      process.exit(1);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
