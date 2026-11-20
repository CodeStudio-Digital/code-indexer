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
import { readFileSync, writeFileSync } from 'node:fs';
import { loadConfig } from '@mcp/shared/utils/config.js';
import { CodeIndexDB } from '@mcp/store/db.js';
import { ProviderStore } from '@mcp/store/provider-store.js';
import { DocStore } from '@mcp/store/doc-store.js';
import { SemanticStore } from '@mcp/store/semantic-store.js';
import { LocalVectorRouter } from '@mcp/store/local-vector-router.js';
import { SemanticProfileRuntime } from '@mcp/indexer/search/semantic-profile-runtime.js';
import {
  assertDocsSemanticBenchmarkReady,
  docsBenchmarkNeedsSemanticIndex,
  resolveActiveDocsBenchmarkQueryServices,
} from '@mcp/indexer/benchmarks/active-query.js';
import { NullReranker } from '@mcp/indexer/search/reranker.js';
import { DocHybridSearch, CrossEncoderReranker } from '@mcp/services/services/docs/index.js';
import { aggregate, parseGold, runOne, type Mode, type QueryScore } from './docs-rag-evaluation.js';

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
      output: { type: 'string' },
      modes: { type: 'string' },
      'min-recall': { type: 'string' },
      'gate-mode': { type: 'string' },
    },
  });
  if (!values.file) {
    console.error('Usage: tsx scripts/docs-rag-eval.ts --file <gold-set.jsonl> [--modes fts,hybrid,rerank] [--min-recall 0.7] [--gate-mode rerank]');
    process.exit(1);
  }
  const requestedModes = (values.modes?.split(',') ?? ['fts', 'hybrid', 'rerank'])
    .map((mode) => mode.trim())
    .filter(Boolean);
  const invalidModes = requestedModes.filter((mode) =>
    mode !== 'fts' && mode !== 'hybrid' && mode !== 'rerank');
  if (requestedModes.length === 0 || invalidModes.length > 0) {
    throw new Error(
      `[docs-eval] invalid modes: ${invalidModes.join(', ') || '(empty)'}; `
      + 'expected fts, hybrid, and/or rerank',
    );
  }
  const modes = [...new Set(requestedModes)] as Mode[];
  const minRecallRaw = values['min-recall'];
  const minRecall = minRecallRaw !== undefined ? Number(minRecallRaw) : NaN;
  if (
    minRecallRaw !== undefined
    && (minRecallRaw.trim() === '' || !Number.isFinite(minRecall) || minRecall < 0 || minRecall > 1)
  ) {
    throw new Error(`[docs-eval] --min-recall must be a number in [0, 1], got: ${minRecallRaw}`);
  }
  const gateModeRaw = values['gate-mode'];
  if (
    gateModeRaw !== undefined
    && gateModeRaw !== 'fts'
    && gateModeRaw !== 'hybrid'
    && gateModeRaw !== 'rerank'
  ) {
    throw new Error(`[docs-eval] invalid --gate-mode: ${gateModeRaw}`);
  }
  const gateMode = (gateModeRaw as Mode | undefined) ?? modes[modes.length - 1]!;
  if (Number.isFinite(minRecall) && !modes.includes(gateMode)) {
    throw new Error(
      `[docs-eval] --gate-mode ${gateMode} was not requested (modes: ${modes.join(', ')})`,
    );
  }
  const gold = parseGold(readFileSync(values.file, 'utf8'));
  if (gold.length === 0) {
    console.error('[docs-eval] gold-set is empty');
    process.exit(1);
  }

  const config = loadConfig();
  const db = new CodeIndexDB(config.dbPath);
  const providerStore = new ProviderStore(config.dbPath);
  providerStore.seedFromEnvIfEmpty();
  const docStore = new DocStore(db.raw());
  const collections = docStore.listCollections();
  const indexedDocChunks = collections.reduce(
    (sum, collection) => sum + docStore.countChunksByCollection(collection.id),
    0,
  );
  if (indexedDocChunks === 0) {
    throw new Error('[docs-eval] invalid corpus: zero indexed documentation chunks');
  }
  const semanticStore = new SemanticStore(db.raw());
  const semanticRuntime = new SemanticProfileRuntime(semanticStore, providerStore);
  const localVectorRouter = new LocalVectorRouter({
    resolveProject: (projectId) => db.getProject(projectId),
    semanticStore,
  });
  const docsQuery = resolveActiveDocsBenchmarkQueryServices(
    semanticStore,
    semanticRuntime,
    localVectorRouter.asVectorStore(),
    collections.map((collection) => collection.id),
  );
  if (docsBenchmarkNeedsSemanticIndex(modes)) {
    await assertDocsSemanticBenchmarkReady(
      docsQuery,
      (namespace, generationId) => localVectorRouter.listIds(namespace, generationId),
    );
  }
  const embeddingService = docsQuery.embeddingService;
  // DocHybridSearch already fans out one namespace per collection. The local
  // router maps every docs:c<ID> namespace to the shared docs-vectors.db while
  // retaining generation isolation inside that physical database.
  const searchable = docsQuery.vectorStore;
  // FTS-only and hybrid-without-rerank runs must not require a configured
  // reranker merely to construct the evaluator.
  const rerankerService = (() => {
    if (!modes.includes('rerank')) return new NullReranker();
    return semanticRuntime.reranker('docs', { strict: true });
  })();
  const reranker = new CrossEncoderReranker(rerankerService);
  const search = new DocHybridSearch(docStore, embeddingService, searchable, undefined, { reranker });

  console.log(
    `[docs-eval] queries=${gold.length} modes=${modes.join(',')} `
    + `indexed_doc_chunks=${indexedDocChunks} `
    + `active_vector_collections=${docsQuery.activeCollectionIds.length} `
    + `indexed_semantic_items=${docsQuery.activeCollections.reduce((sum, row) => sum + row.indexedItems, 0)} `
    + `reranker=${rerankerService.name}`,
  );

  const all: QueryScore[] = [];
  const unclassifiedErrors: string[] = [];
  for (const mode of modes) {
    process.stdout.write(`  running ${mode}… `);
    const t0 = Date.now();
    for (const q of gold) {
      try {
        all.push(await runOne(search, mode, q));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        unclassifiedErrors.push(`${mode} "${q.query}": ${message}`);
        console.error(`\n  [${mode}] "${q.query}" failed: ${message}`);
      }
    }
    console.log(`done (${Date.now() - t0}ms)`);
  }

  // Overall per mode.
  for (const mode of modes) {
    const rows = all.filter(row => row.mode === mode);
    const stats = aggregate(rows);
    const counts = new Map<string, number>();
    for (const row of rows) {
      const key = [row.executed, row.reranked ? 'reranked' : row.skipReason ?? 'base'].join('/');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    console.log(`[docs-eval] requested=${mode} executed=${JSON.stringify(Object.fromEntries(counts))} `
      + `correctAbsence=${stats.correctAbsences}/${stats.negatives} positives=${stats.n}`);
  }
  if (values.output) writeFileSync(values.output, JSON.stringify({ modes, rows: all }, null, 2));
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

  await semanticRuntime.dispose();
  await localVectorRouter.drainAndClose();
  providerStore.close();
  db.close();

  if (unclassifiedErrors.length > 0) {
    throw new Error(
      `[docs-eval] unclassified search error(s):\n- ${unclassifiedErrors.join('\n- ')}`,
    );
  }
  const incompleteModes = modes.filter((mode) =>
    all.filter((row) => row.mode === mode).length !== gold.length);
  if (incompleteModes.length > 0) {
    throw new Error(
      `[docs-eval] invalid benchmark: zero or incomplete evaluated items for ${incompleteModes.join(', ')}`,
    );
  }

  // Optional CI gate.
  if (Number.isFinite(minRecall)) {
    const rows = all.filter(row => row.mode === gateMode);
    if (!rows.some(row => row.positive)) throw new Error('[gate] no positive documentation cases');
    if (gateMode !== 'fts' && rows.some(row => row.executed !== 'hybrid' || row.vectorCollections?.failed.length)) {
      throw new Error('[gate] incomplete hybrid retrieval');
    }
    if (gateMode === 'rerank' && !rows.some(row => row.positive && row.reranked)) {
      throw new Error('[gate] no positive case executed reranking');
    }
    if (rows.some(row => ['inference_unavailable', 'incomplete_scores'].includes(row.skipReason ?? ''))) {
      throw new Error('[gate] required inference degraded');
    }
    const r5 = aggregate(rows).recall5;
    console.log(`\n[gate] ${gateMode} R@5=${r5.toFixed(3)} (min ${minRecall})`);
    if (r5 < minRecall) {
      throw new Error('[gate] FAILED — retrieval recall below threshold');
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
