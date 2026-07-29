/**
 * Public types for the DocsAgent — the multi-step retrieval orchestrator
 * that lives alongside the coder but talks ONLY to the doc-corpus search
 * layer. The DocsAgent is a thin shell around `CoderRunner` from
 * @mcp/code-agent (composition, not modification): a different toolset,
 * a different system prompt, a different provider role binding, but the
 * same battle-tested run loop, compaction, abort handling.
 */

import type { ResolveContext } from '@mcp/services/pipelines/index.js';
import type { SessionId } from '@mcp/session-storage';

export type DocsResearchTrigger = 'user' | 'coder';

export interface RunDocsAgentOptions {
  /** Free-form natural-language question. Becomes the user's first turn. */
  query: string;
  /**
   * Optional collection-name filter — the docs_search tool will scope to
   * these by default. When omitted, the agent reads `docs_list_sources`
   * on its first turn and decides where to look.
   */
  collections?: string[];
  /**
   * Who triggered the run. Persisted in the docs bundle and used to decide
   * whether to render the result inline in a coder session timeline.
   */
  triggeredBy: DocsResearchTrigger;
  /**
   * Optional link back to a coder session that called `docs_deep_research`.
   * Stored as the bundle's parent UUID so the dashboard can render the
   * research inline with the calling chat. Null/undefined for
   * `triggeredBy='user'`.
   */
  parentCoderSessionId?: SessionId | null;
  /** Maximum turns the runner will execute before aborting. Default 6. */
  maxTurns?: number;
  /** Optional abort signal — surfaces through to the underlying CoderRunner. */
  signal?: AbortSignal;
  /**
   * Optional pipeline-resolver context. Forwarded to QueryRewriter and
   * Reranker so an admin can scope DocsAgent bindings per template/session.
   * The DocsAgent itself uses the same context to resolve its scorer_llm
   * and classifier bindings.
   */
  resolveContext?: ResolveContext;
}

export type ResearchConfidence = 'high' | 'medium' | 'low';

export interface DocsResearchTelemetry {
  /** Turns the runner actually executed before finishing or aborting. */
  turns: number;
  /** How many times the agent called docs_search across the run. */
  searches: number;
  /** How many docs_read_chunk calls were issued. */
  chunks_read: number;
  /** Total LLM tokens consumed (across rewriter, reranker, scorer, synth). */
  input_tokens: number;
  output_tokens: number;
  /** Total cost across all LLM calls (in USD). */
  cost_usd: number;
  /** Wall-clock time of the entire research run in ms. */
  duration_ms: number;
}

export interface DocsResearchResult {
  /** Opaque UUID of the persistent filesystem session bundle. */
  sessionId: SessionId;
  /**
   * Markdown answer with footnote citations [^1] [^2] resolved against
   * `chunks_cited`. The DocsAgent renders this via the `docs_synthesize`
   * tool before emitting `docs_finish`.
   */
  markdown: string;
  /**
   * Chunk ids the agent actually cited in the markdown. The dashboard
   * uses this to render clickable footnote links back to the source.
   */
  chunks_cited: number[];
  /**
   * Agent's self-reported confidence in the answer. 'high' means the
   * docs covered every part of the query; 'medium' means partial; 'low'
   * is a hedge that the answer may be incomplete or out of date.
   */
  confidence: ResearchConfidence | null;
  /** Set when status='failed' or 'aborted'. */
  errorMessage?: string;
  /** Telemetry counters used to drive the dashboard timeline + costs page. */
  telemetry: DocsResearchTelemetry;
}

export interface RunDocsAgentHandle {
  /** The persistent research-session bundle UUID. */
  sessionId: SessionId;
  /** Resolves with the final result once the runner finishes. */
  done: Promise<DocsResearchResult>;
  /** Imperative cancel — aborts the underlying CoderRunner. */
  abort: () => void;
}
