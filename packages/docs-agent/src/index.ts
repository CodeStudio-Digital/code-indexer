/**
 * DocsAgent — multi-step retrieval orchestrator over the doc corpus.
 *
 * Composition over modification: this package IMPORTS `CoderRunner`,
 * `ToolRegistry`, and the provider factory from @mcp/code-agent /
 * @mcp/services and assembles them with a docs-specific toolset +
 * system prompt + provider role binding. Zero edits to @mcp/code-agent.
 *
 * Lifecycle of `runDocsAgent`:
 *   1. Create a `kind=docs` filesystem session bundle.
 *   2. Resolve the `docs_research/scorer_llm` binding → ChatProvider.
 *   3. Build a narrow ToolRegistry (docs_search, docs_read_chunk,
 *      docs_list_sources, docs_synthesize, docs_finish).
 *   4. Inject the user's query as the first user message.
 *   5. Run the CoderRunner loop. When `docs_finish` lands, the tool
 *      handler writes to a shared slot and calls runner.abort() — the
 *      loop exits cleanly.
 *   6. Read the slot. Update state.json to 'completed' (slot
 *      filled) or 'failed' (slot empty — maxTurns hit or runtime error).
 *   7. Return DocsResearchResult.
 */
import os from 'node:os';
import { CoderRunner } from '@mcp/code-agent/core/runner.js';
import type { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { asAbortSignal } from '@mcp/code-agent/core/abort-signal.js';
import { createCoderProvider } from '@mcp/services/providers/factory.js';
import type {
  PipelineProviderResolver,
  ResolveContext,
  ResolvedBinding,
} from '@mcp/services/pipelines/index.js';
import type { DocHybridSearch } from '@mcp/services/services/docs/index.js';
import type { DocStore } from '@mcp/store/doc-store.js';
import { buildDocsToolset, type DocsToolsetCounters, type PlanSlot } from './tools/index.js';
import type { DocsFinishSlot, DocsFinishPayload } from './tools/docs-finish.js';
import { reviewAnswer, applyReview } from './review/review-gate.js';
import { buildDocsSystemPrompt } from './prompts/system-prompt.js';
import {
  DocsResearchSessionsStore,
  type DocsResearchStatus,
} from './session-store/docs-research-sessions-store.js';
import type {
  RunDocsAgentOptions,
  RunDocsAgentHandle,
  DocsResearchResult,
  ResearchConfidence,
} from './types.js';

// Hard behavioral budget: evidence tools enforce four searches/eight reads;
// six runner rounds are enough to plan, retrieve, synthesize and finish.
const DEFAULT_MAX_TURNS = 6;
/** Hard cap so a misconfigured caller can't trigger arbitrarily long runs. */
const MAX_MAX_TURNS = 6;

export interface RunDocsAgentDeps {
  /** Filesystem session authority for docs bundles. */
  sessionStore: FsSessionStore;
  /** Doc-corpus CRUD. */
  docStore: DocStore;
  /** Hybrid search backend (constructed in http-api/deps.ts). */
  docHybridSearch: DocHybridSearch;
  /** Provider/role resolver (catalog + admin overrides). */
  pipelineResolver: PipelineProviderResolver;
}

/**
 * Runs the DocsAgent end-to-end. Synchronous up to setup, then returns a
 * handle whose `done` resolves with the final `DocsResearchResult`.
 *
 * Errors during setup (no binding configured, no provider, etc.) reject
 * `done` after the session row is marked 'failed'. Errors during the
 * runner loop are caught and translated into 'failed'/'aborted' too.
 */
export async function runDocsAgent(
  opts: RunDocsAgentOptions,
  deps: RunDocsAgentDeps,
): Promise<RunDocsAgentHandle> {
  const sessionsStore = new DocsResearchSessionsStore(deps.sessionStore);
  const sessionId = await sessionsStore.create({
    triggered_by: opts.triggeredBy,
    parent_coder_session_id: opts.parentCoderSessionId ?? null,
    query: opts.query,
    collections: opts.collections,
  });

  // We never throw from this top-level function — anything that goes wrong
  // is captured into `done` so the caller can branch on a single Promise.
  const startedAt = Date.now();
  const counters: DocsToolsetCounters = {
    searches: 0,
    chunks_read: 0,
    synthesizes: 0,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
  };
  const finishSlot: DocsFinishSlot = { payload: null };
  const planSlot: PlanSlot = { subQuestions: null };

  // Build a placeholder for the abort handle so we can wire `handle.abort`
  // before the runner exists.
  let runnerRef: CoderRunner | null = null;
  const controller = new AbortController();
  const parentSignal = asAbortSignal(opts.signal);
  const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
  const abortHandle = (): void => {
    controller.abort(new Error('Docs research cancelled'));
    runnerRef?.abort();
  };

  const done = (async (): Promise<DocsResearchResult> => {
    try {
      signal.throwIfAborted();
      // 1. Resolve provider binding (scorer_llm).
      const binding = await deps.pipelineResolver.resolveOrNull(
        'docs_research',
        'scorer_llm',
        opts.resolveContext ?? {},
      );
      signal.throwIfAborted();
      if (!binding) {
        return finalizeFailed(
          sessionsStore,
          sessionId,
          startedAt,
          counters,
          'failed',
          'No provider binding configured for docs_research/scorer_llm. Ask an admin to configure one in the admin panel before running the DocsAgent.',
        );
      }

      // 2. Build provider from the resolved binding. The provider id on
      //    `binding.provider.id` is the ProviderStore row id; pass it to
      //    `createCoderProvider` which dispatches through the same factory
      //    the coder uses.
      const provider = await createCoderProvider(binding.provider.id, binding.modelId);
      signal.throwIfAborted();

      // 3. Build the toolset.
      const tools = buildDocsToolset({
        docStore: deps.docStore,
        docHybridSearch: deps.docHybridSearch,
        resolver: deps.pipelineResolver,
        resolveContext: opts.resolveContext,
        scopedCollections: opts.collections,
        finishSlot,
        planSlot,
        counters,
      });

      // 4. Wrap in a ToolRegistry.
      const registry = new ToolRegistry();
      registry.registerAll(tools);

      // 5. Build the system prompt — interpolates the live collection list.
      const collections = deps.docStore.listCollections();
      const systemPrompt = buildDocsSystemPrompt({
        collections,
        scopedCollections: opts.collections,
      });

      // 6. Build a minimal ToolContext. DocsAgent does NOT touch the
      //    filesystem, so cwd is a tmp dir placeholder + projectName is a
      //    stable string. The runner uses these for logging only.
      const toolContext: ToolContext = {
        cwd: os.tmpdir(),
        projectName: 'docs-agent',
        // AbortSignal loses its EventTarget methods when structured-cloned.
        // The worker RPC now rehydrates a local signal, while this guard keeps
        // rolling-restart/third-party callers from poisoning ToolContext.
        signal,
      };

      // 7. Construct the runner. Deliberately omit sessionStore — the
      //    DocsAgent doesn't persist its message history (only the final
      //    markdown is durable). `maxTurns` enforces the docs_finish
      //    contract: a runaway agent gets force-stopped, the slot stays
      //    empty, the session row records 'failed' with a clear reason.
      const maxTurns = clamp(opts.maxTurns ?? DEFAULT_MAX_TURNS, 1, MAX_MAX_TURNS);
      const runner = new CoderRunner({
        provider,
        registry,
        systemPrompt,
        toolContext,
        maxTurns,
        sessionId,
        isSubagent: true, // tag logs as a sub-run
      });
      runnerRef = runner;

      // 8. Inject the user's query as the first message.
      runner.pushUserContent([{ type: 'text', text: opts.query }]);

      // 9. Run the loop. The runner resolves on its own when:
      //    - docs_finish handler called runner.abort()
      //    - maxTurns was reached
      //    - opts.signal aborted
      //    - the provider returned a stop_sequence
      const runResult = await runner.run();
      signal.throwIfAborted();
      const turns = Math.max(0, runner.messages.filter((m) => m.role === 'assistant').length);

      // 10. Map slot → result.
      if (finishSlot.payload) {
        // Fidelity review gate — the strong model checks the (cheaply
        // synthesized) answer against the cited chunks before it ships. Runs
        // once, post-loop; degrades to a no-op on any reviewer failure.
        const reviewed = await runFidelityReview(
          finishSlot.payload,
          opts.query,
          planSlot.subQuestions,
          binding,
          deps.docStore,
          counters,
          signal,
        );
        signal.throwIfAborted();
        const result: DocsResearchResult = {
          sessionId,
          markdown: reviewed.markdown,
          chunks_cited: finishSlot.payload.chunks_cited,
          confidence: reviewed.confidence,
          telemetry: buildTelemetry(
            turns,
            counters,
            runResult.totalUsage.input_tokens ?? 0,
            runResult.totalUsage.output_tokens ?? 0,
            Date.now() - startedAt,
          ),
        };
        // Persist as completed.
        await sessionsStore.complete(sessionId, {
          status: 'completed',
          num_turns: turns,
          num_searches: counters.searches,
          num_chunks_read: counters.chunks_read,
          query_rewrites_used: 0,
          reranks_used: 0,
          final_markdown: result.markdown,
          final_chunk_ids: result.chunks_cited,
          confidence: result.confidence,
          error_message: null,
          input_tokens: result.telemetry.input_tokens,
          output_tokens: result.telemetry.output_tokens,
          cost_usd: result.telemetry.cost_usd,
        });
        return result;
      }

      // Slot empty → runner exited without docs_finish.
      const reason = runResult.reason ?? 'unknown';
      return finalizeFailed(
        sessionsStore,
        sessionId,
        startedAt,
        counters,
        runner['aborted'] === true ? 'aborted' : 'failed',
        `Runner exited without calling docs_finish (reason: ${reason}, turns: ${turns}). The agent likely hit maxTurns or was aborted before synthesizing a result.`,
        turns,
        runResult.totalUsage.input_tokens ?? 0,
        runResult.totalUsage.output_tokens ?? 0,
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return finalizeFailed(
        sessionsStore,
        sessionId,
        startedAt,
        counters,
        signal.aborted ? 'aborted' : 'failed',
        `runDocsAgent crashed: ${message}`,
      );
    }
  })();

  return {
    sessionId,
    done,
    abort: abortHandle,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Run the fidelity review gate over a finished answer and fold the verdict
 * in. Hydrates the cited chunks, asks the strong `binding` to verify each
 * claim, and applies any repair (corrected markdown + downgraded
 * confidence). The reviewer's tokens roll into `counters` so the cost is
 * never hidden. Disable with DOCS_REVIEW_GATE=0.
 */
async function runFidelityReview(
  payload: DocsFinishPayload,
  query: string,
  subQuestions: string[] | null,
  binding: ResolvedBinding,
  docStore: DocStore,
  counters: DocsToolsetCounters,
  signal?: AbortSignal,
): Promise<{ markdown: string; confidence: ResearchConfidence }> {
  signal?.throwIfAborted();
  if (process.env.DOCS_REVIEW_GATE === '0') {
    return { markdown: payload.markdown, confidence: payload.confidence };
  }
  const chunks = docStore.getChunksByIds(payload.chunks_cited).map((c) => ({
    chunk_id: c.id,
    heading_path: c.heading_path,
    content: c.content,
  }));
  const review = await reviewAnswer({
    signal,
    query,
    markdown: payload.markdown,
    chunks,
    binding,
    subQuestions: subQuestions ?? undefined,
  });
  if (review.usage) {
    counters.input_tokens += review.usage.input_tokens;
    counters.output_tokens += review.usage.output_tokens;
  }
  const applied = applyReview(payload.markdown, payload.confidence, review);
  return { markdown: applied.markdown, confidence: applied.confidence };
}

function buildTelemetry(
  turns: number,
  counters: DocsToolsetCounters,
  runnerInputTokens: number,
  runnerOutputTokens: number,
  durationMs: number,
) {
  // Sum tokens across the runner and the synthesize tool. The reranker /
  // rewriter LLMs are accounted via pipeline_telemetry rather than rolled
  // into the per-session totals (different cost center).
  return {
    turns,
    searches: counters.searches,
    chunks_read: counters.chunks_read,
    input_tokens: runnerInputTokens + counters.input_tokens,
    output_tokens: runnerOutputTokens + counters.output_tokens,
    cost_usd: counters.cost_usd,
    duration_ms: durationMs,
  };
}

async function finalizeFailed(
  sessionsStore: DocsResearchSessionsStore,
  sessionId: import('@mcp/session-storage').SessionId,
  startedAt: number,
  counters: DocsToolsetCounters,
  status: DocsResearchStatus,
  errorMessage: string,
  turns: number = 0,
  runnerInputTokens: number = 0,
  runnerOutputTokens: number = 0,
): Promise<DocsResearchResult> {
  const telemetry = buildTelemetry(
    turns,
    counters,
    runnerInputTokens,
    runnerOutputTokens,
    Date.now() - startedAt,
  );
  const result: DocsResearchResult = {
    sessionId,
    markdown: `_(No answer — ${errorMessage})_`,
    chunks_cited: [],
    confidence: 'low' satisfies ResearchConfidence,
    errorMessage,
    telemetry,
  };
  await sessionsStore.complete(sessionId, {
    status,
    num_turns: turns,
    num_searches: counters.searches,
    num_chunks_read: counters.chunks_read,
    query_rewrites_used: 0,
    reranks_used: 0,
    final_markdown: null,
    final_chunk_ids: [],
    confidence: null,
    error_message: errorMessage,
    input_tokens: telemetry.input_tokens,
    output_tokens: telemetry.output_tokens,
    cost_usd: telemetry.cost_usd,
  });
  return result;
}

// ─── Re-exports ─────────────────────────────────────────────────────

export type {
  RunDocsAgentOptions,
  RunDocsAgentHandle,
  DocsResearchResult,
  DocsResearchTelemetry,
  ResearchConfidence,
  DocsResearchTrigger,
} from './types.js';

export {
  DocsResearchSessionsStore,
  type DocsResearchSessionRow,
  type DocsResearchStatus,
} from './session-store/docs-research-sessions-store.js';

export { buildDocsToolset } from './tools/index.js';
export type { DocsFinishPayload, DocsFinishSlot, DocsToolsetCounters } from './tools/index.js';

export {
  extractCitedIndices,
  resolveCitedChunkIds,
  formatCitation,
  buildBibliography,
} from './retrieval/citations.js';
