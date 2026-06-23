# @mcp/candidate-pipeline

A composable framework for building "rank a set of candidates" pipelines
across the MCP codebase. Inspired by [xai-org/x-algorithm's
candidate-pipeline crate](https://github.com/xai-org/x-algorithm) — same
shape, translated to TypeScript.

## When to reach for it

Use this framework whenever the answer to "what should I show / spawn /
suggest next?" requires:

1. **Multiple sources** of candidates (e.g., FTS + vector store + LRU cache)
2. **Filtering** by hard constraints (tier, capacity, dependencies)
3. **Scoring** by one or more weighted signals
4. **Selecting** a top-K subset, possibly with diversity/spacing constraints
5. **Side effects** that should fire AFTER the response is built
   (logging, shadow traffic, telemetry)

If you only need "filter a list and return it", a plain `Array.filter` is
enough. The framework starts paying off around 3+ stages.

## Quick start

```typescript
import {
  CandidatePipeline,
  TopKSelector,
  weightedSum,
  type Source,
  type Scorer,
} from '@mcp/candidate-pipeline';

interface Q extends PipelineQuery { taskText: string }
interface C extends PipelineCandidate { name: string; score: number }

const fromDb: Source<Q, C> = {
  name: 'db',
  enable: () => true,
  async source(_q) { return await db.listCandidates(); },
};

const lengthScorer: Scorer<Q, C> = {
  name: 'length',
  enable: () => true,
  async score(_q, candidates) {
    return candidates.map((c) => ({
      ok: true,
      candidate: { ...c, score: c.name.length / 100 },
    }));
  },
  update(target, scored) { target.score = scored.score; },
};

const pipeline = new CandidatePipeline<Q, C>(
  { name: 'demo' },
  {
    sources: [fromDb],
    scorers: [lengthScorer],
    selector: new TopKSelector({ k: 10, scoreOf: (c) => c.score }),
  },
);

const result = await pipeline.execute({ queryId: 'q1', taskText: 'find files' });
console.log(result.selected, result.diag);
```

## The 8 traits

| Trait | Runs | Purpose |
|---|---|---|
| `QueryHydrator<Q>` | parallel, BEFORE sources | Enrich the query (compute task embedding, fetch user prefs, …) |
| `Source<Q, C>` | parallel fan-out | Produce candidates from a source (FTS, vector store, registry, …) |
| `Hydrator<Q, C>` | parallel | Enrich each candidate (fetch metadata, embeddings, history, …) |
| `CachedHydrator<Q, C, K, V>` | parallel | Hydrator with automatic cache-hit/miss routing |
| `Filter<Q, C>` | sequential | Partition into `{ kept, removed }`; removed is observability, not silent drop |
| `Scorer<Q, C>` | sequential async, ORDER-PRESERVING | Add a numeric score (or multiple signals) |
| `Selector<Q, C>` | once | Pick the final top-K |
| `SideEffect<Q, C>` | fire-and-forget after response | Log, publish, run shadow variants, … |

Every trait has `enable(query)` checked at runtime. Skipped components
don't run and don't emit telemetry.

## Invariants (do NOT break)

1. **Hydrators / Scorers / PostHydrators** MUST return an array the same
   length as the input, in the same order. The orchestrator zips them
   back onto the in-place candidate set.
2. **Filters** return `{ kept, removed }` — never silently drop.
3. **SideEffects** fire after the response is built (`setImmediate`).
   Their failures must NEVER affect the returned `PipelineResult`.
4. **Telemetry** is best-effort — `cfg.telemetry?.emit(event)` is wrapped
   in try/catch. A misbehaving sink can't break a pipeline.

## Pre-built stages

In `src/scorers/` and `src/selectors/`:

- `rrfMerge` — Reciprocal Rank Fusion (extracted from the indexer's hybrid search)
- `weightedSum` — translated from `home-mixer/weighted_scorer.rs:44-70`
- `cosineSimilarity` / `cosineSimilarities` — two-tower retrieval
- `recencyDecay` — exponential half-life decay
- `batchFrequencyBoost` — saturating boost on observed recency
- `withCandidateIsolationCache` — score cacher for queries-meeting-candidates
- `simHashSignature` / `bucketize` / `computeLshEntry` — LSH primitives
- `TopKSelector` / `DiversitySelector` / `BlenderSelector`
- `LruCache` — moka-style in-process LRU with TTL

## Pre-built infrastructure

In `src/`:

- `CandidatePipeline` — the orchestrator
- `InMemoryTelemetrySink` / `CompositeTelemetrySink` — telemetry sinks
- `SqliteTelemetrySink` — DB-backed sink for the `pipeline_telemetry` table

## Benchmark

```bash
pnpm tsx packages/candidate-pipeline/bench/baseline.ts
```

Writes `bench/results/baseline-YYYY-MM-DD.json` with p50/p95/p99 for every
primitive. Re-run after any framework change to make sure you didn't
regress.

## Concrete pipelines built on top of this framework

| Package | Pipeline | Purpose | Activation |
|---|---|---|---|
| `@mcp/code-agent/tool-selection` | ToolSelectionPipeline (+ `applyToolSelectionThin` thin path) | Pick top-K tools for the current task | `MCP_PIPELINES_TOOL_SELECTION=1` |
| `@mcp/code-agent/context-relevance` | ContextRelevancePipeline | Decide which past messages to keep during compaction | `MCP_PIPELINES_CONTEXT_RELEVANCE=1` |
| `@mcp/code-agent/todo-priority` | TodoPriorityPipeline | Reorder TodoWrite items by impact × urgency × dependencies | `MCP_PIPELINES_TODO_PRIORITY=1` |
| `@mcp/company/role-pipeline` | RolePipeline | Recommend which subordinate role to spawn | Wired in company orchestrator |
| `@mcp/company/kanban-priority` | KanbanPriorityPipeline | Order kanban cards by computed priority score | Wired in kanban service |
| `@mcp/services/quality` | QualityClassifierPipeline | Run 5 LLM-backed classifiers in parallel on agent outputs | `MCP_PIPELINES_QUALITY_CLASSIFIERS=1` |
| `@mcp/indexer/search` | HybridSearch | FTS + vector + RRF + cross-encoder rerank | Always on (mode picked by planner or caller) |
| `@mcp/indexer/search` | RecentFilesSource (I2 — Thunder-style hot cache) | Optional 3rd stream in `mode='hybrid'` for recently-touched files | `MCP_PIPELINES_RECENT_FILES_SOURCE=1` + `touch()` calls wired |
| `@mcp/services/services/docs/search` | DocSearch | Doc retrieval with QueryRewriter + Reranker | Wired in doc routes |

**Cross-cutting infrastructure**:
- **Decider** (`@mcp/services/pipelines/decider`) — `ConfigJsonDecider` / `EnvVarDecider` / `ConstantDecider` / `CompositeDecider` (read order: session config → env → constant). Mirrors `PipelineQuery.params()/decider()` from `candidate-pipeline/candidate_pipeline.rs`.
- **SqliteTelemetrySink** (`@mcp/store/pipeline-telemetry-store`) — every pipeline writes per-stage traces to `pipeline_telemetry`. Histogram + cache-hit queries power the admin panel.
- **Shadow traffic** (`@mcp/services/shadow-traffic`) — sample requests run against variants for A/B comparison. Used by `tool_selection` today.
- **`IndexAgent.onFilesUpdated()` listener bus** (I3) — fire-and-forget after each `indexProject()` completes. Wired to `makeHybridSearchCacheInvalidator(hybridSearch)` in `api-handlers/projects` so the LRU clears automatically.
- **`coder_turn_telemetry` table** — input/output tokens, history chars, tools called, compaction triggers per turn. Read by `src/benchmarks/runner-baseline.ts`.
- **Baseline benches** — `bench/README.md` documents the workflow. Capture before any pipeline change, diff after, revert if metrics regress per the criteria in `plans/https-github-com-xai-org-x-algorithm-clo-shimmying-oasis.md`.

Adding a new pipeline:

1. Define `Q extends PipelineQuery` and `C extends PipelineCandidate`.
2. Implement at least one `Source<Q, C>` and one `Selector<Q, C>`.
3. Optionally add hydrators, filters, scorers, side effects.
4. Compose into a `CandidatePipeline<Q, C>` factory function.
5. Register a binding entry in `@mcp/services/pipelines/catalog.ts` if
   the pipeline calls an LLM (so the admin panel can configure it).
6. Wire into `apps/http-api/server/deps.ts`.
7. Add a `MCP_PIPELINES_*` env flag (default OFF) checked by the wiring.
8. Update the table above + bench/README.md.
