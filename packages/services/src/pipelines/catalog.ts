/**
 * Catalog of all pipelines and their provider-binding roles.
 *
 * The admin UI uses this list to render the bindings panel — each entry
 * appears as a row even before any binding row exists in the DB. Adding a
 * new pipeline here is the FIRST step when introducing a new pipeline:
 * it shows up in the admin panel, the admin sets a provider+model, then
 * the pipeline code uses `PipelineProviderResolver.resolve(name, role)`.
 *
 * Pipelines flagged `comingSoon: true` are part of the refactor plan
 * (see the plan file) but not yet wired — they appear in the admin panel
 * so an operator can pre-configure them before the code lands.
 */

export type BindingRole =
  | 'embedder'
  | 'classifier'
  | 'reranker'
  | 'scorer_llm'
  | 'hyde'
  | 'compaction_llm'
  | 'link_extractor'
  | 'rewriter'
  | 'reviewer'
  | 'vision'
  | 'distiller';

export interface PipelineCatalogEntry {
  pipelineName: string;
  bindingRole: BindingRole;
  /** Human-friendly description for the admin panel. */
  description: string;
  /** Recommended default (a hint shown in the UI, not auto-applied). */
  recommendedDefault?: {
    providerKind: string;
    modelHint: string;
    config?: Record<string, unknown>;
  };
  /** Whether the consuming pipeline code is already implemented. */
  comingSoon?: boolean;
  /** Which refactor phase introduces this pipeline. */
  introducedInPhase: string;
}

export const PIPELINE_CATALOG: PipelineCatalogEntry[] = [
  // ─── Existing indexer pipelines (Phase 1 — extracted) ────────────────────
  {
    pipelineName: 'indexer_search',
    bindingRole: 'embedder',
    description: 'Embeddings used by the hybrid search vector stage.',
    introducedInPhase: '1',
  },
  {
    pipelineName: 'indexer_search',
    bindingRole: 'reranker',
    description: 'Cross-encoder reranker for hybrid search top-K.',
    introducedInPhase: '1',
  },
  {
    pipelineName: 'indexer_search',
    bindingRole: 'hyde',
    description: 'Hypothetical Document Embeddings synthesizer (optional).',
    introducedInPhase: '1',
  },

  // ─── Chat-individual pipelines (Phases 1.5-1.8) ──────────────────────────
  // All wired and consumed by the runner / context-relevance compactor /
  // sub-agent cache. The `comingSoon` flag was kept while the consuming
  // code was being written; now that the code ships, every entry below
  // is live behind its respective `MCP_PIPELINES_*` env flag.
  {
    pipelineName: 'tool_selection',
    bindingRole: 'embedder',
    description: 'Embeds task + tool descriptions to pick the top-K tools per turn.',
    recommendedDefault: { providerKind: 'cloudflare', modelHint: '@cf/baai/bge-base-en-v1.5' },
    introducedInPhase: '1.5',
  },
  {
    pipelineName: 'context_relevance',
    bindingRole: 'embedder',
    description: 'Embeds session messages to rank by relevance during compaction.',
    recommendedDefault: { providerKind: 'cloudflare', modelHint: '@cf/baai/bge-base-en-v1.5' },
    introducedInPhase: '1.6',
  },
  {
    pipelineName: 'todo_priority',
    bindingRole: 'embedder',
    description: 'Optional — only used if semantic dependency detection is enabled.',
    recommendedDefault: { providerKind: 'cloudflare', modelHint: '@cf/baai/bge-base-en-v1.5' },
    introducedInPhase: '1.7',
  },
  {
    pipelineName: 'sub_agent_cache',
    bindingRole: 'embedder',
    description: 'Fuzzy-match cache lookup for Explore/Plan agent invocations.',
    recommendedDefault: { providerKind: 'cloudflare', modelHint: '@cf/baai/bge-base-en-v1.5' },
    introducedInPhase: '1.8',
  },

  // ─── Multi-agent pipelines (Phases 2-3) ──────────────────────────────────
  {
    pipelineName: 'role_pipeline',
    bindingRole: 'embedder',
    description: 'Embeds task + role descriptions for role recommendation (two-tower).',
    recommendedDefault: { providerKind: 'cloudflare', modelHint: '@cf/baai/bge-base-en-v1.5' },
    introducedInPhase: '2',
  },
  {
    pipelineName: 'kanban_priority',
    bindingRole: 'embedder',
    description: 'Optional — semantic similarity for kanban card grouping.',
    recommendedDefault: { providerKind: 'cloudflare', modelHint: '@cf/baai/bge-base-en-v1.5' },
    introducedInPhase: '3',
  },

  // ─── Quality classifiers (Phase 6) ───────────────────────────────────────
  // All 5 are wired. They run in parallel (`PlanMaster` pattern) after
  // each turn when MCP_PIPELINES_QUALITY_CLASSIFIERS=1. The recommended
  // default below is the Cloudflare Llama 3.2 3B; operators commonly
  // swap to OpenAI gpt-4o-mini / Gemini Flash via the admin panel.
  {
    pipelineName: 'quality_off_topic',
    bindingRole: 'classifier',
    description: 'Classifies whether an agent output stays within the task scope.',
    recommendedDefault: {
      providerKind: 'cloudflare',
      modelHint: '@cf/meta/llama-3.2-3b-instruct',
      config: { temperature: 0.000001, max_tokens: 256 },
    },
    introducedInPhase: '6',
  },
  {
    pipelineName: 'quality_completeness',
    bindingRole: 'classifier',
    description: 'Classifies whether the task was actually completed.',
    recommendedDefault: {
      providerKind: 'cloudflare',
      modelHint: '@cf/meta/llama-3.2-3b-instruct',
      config: { temperature: 0.000001, max_tokens: 256 },
    },
    introducedInPhase: '6',
  },
  {
    pipelineName: 'quality_code',
    bindingRole: 'classifier',
    description: 'Detects code smells (TODO without impl, console.log, magic numbers).',
    recommendedDefault: {
      providerKind: 'cloudflare',
      modelHint: '@cf/meta/llama-3.2-3b-instruct',
      config: { temperature: 0.000001, max_tokens: 256 },
    },
    introducedInPhase: '6',
  },
  {
    pipelineName: 'quality_policy',
    bindingRole: 'classifier',
    description: 'Detects policy violations (destructive tools without confirm, secrets in code).',
    recommendedDefault: {
      providerKind: 'cloudflare',
      modelHint: '@cf/meta/llama-3.2-3b-instruct',
      config: { temperature: 0.000001, max_tokens: 256 },
    },
    introducedInPhase: '6',
  },
  {
    pipelineName: 'quality_tool_misuse',
    bindingRole: 'classifier',
    description: 'Detects tool-call loops and obviously wrong tool selection.',
    recommendedDefault: {
      providerKind: 'cloudflare',
      modelHint: '@cf/meta/llama-3.2-3b-instruct',
      config: { temperature: 0.000001, max_tokens: 256 },
    },
    introducedInPhase: '6',
  },
  {
    pipelineName: 'snapshot_review',
    bindingRole: 'reviewer',
    description: 'Automatic code review over active Session Snapshot diffs.',
    recommendedDefault: {
      providerKind: 'anthropic',
      modelHint: 'claude-sonnet-4',
      config: { temperature: 0, max_tokens: 4000, json_mode: true },
    },
    introducedInPhase: 'snapshot-review',
  },

  // ─── Documentação (RAG) pipelines (Phase 9) ──────────────────────────────
  // Backs the "Documentação" sidebar feature: per-collection RAG over
  // user-curated docs (PDF + URL crawls). The crawl gate uses a cheap
  // classifier to keep/drop pages before paying for enrichment; the
  // enricher writes summary + concepts onto each chunk; the embedder
  // is shared with the existing indexer_search but kept separate so an
  // admin can pick a different embedding model for docs vs code.
  {
    pipelineName: 'doc_ingest',
    bindingRole: 'classifier',
    description: 'Relevance gate — cheap LLM that decides whether a fetched page is real documentation content (vs nav/footer/login).',
    recommendedDefault: {
      providerKind: 'cloudflare',
      modelHint: '@cf/meta/llama-3.2-3b-instruct',
      config: { temperature: 0.000001, max_tokens: 256 },
    },
    introducedInPhase: '9',
  },
  {
    pipelineName: 'doc_ingest',
    bindingRole: 'scorer_llm',
    description: 'Per-chunk enricher — writes summary + concepts onto each doc chunk.',
    recommendedDefault: {
      providerKind: 'cloudflare',
      modelHint: '@cf/meta/llama-3.1-8b-instruct',
      config: { temperature: 0.2, max_tokens: 600 },
    },
    introducedInPhase: '9',
  },
  {
    pipelineName: 'doc_ingest',
    bindingRole: 'embedder',
    description:
      'INFORMATIONAL ONLY — not consumed by code. The docs embedder is governed by the shared embedding_configs default (the worker emits @cf/baai/bge-m3, 1024-dim, multilingual) for BOTH corpus and queries. This row is reserved for future per-corpus embedder selection; setting it today has no effect.',
    recommendedDefault: { providerKind: 'cloudflare', modelHint: '@cf/baai/bge-m3' },
    introducedInPhase: '9',
  },
  {
    pipelineName: 'doc_search',
    bindingRole: 'reranker',
    description:
      'Optional reranker for the top-K chunks before they are returned to the agent. Default is an LLM-as-reranker that scores each (query, chunk) pair; a cross-encoder model can be swapped in via the admin panel. Caches verdicts in doc_rerank_cache (24h TTL).',
    recommendedDefault: {
      providerKind: 'cloudflare',
      modelHint: '@cf/meta/llama-3.1-8b-instruct',
      config: { temperature: 0, max_tokens: 600 },
    },
    introducedInPhase: '10',
  },
  {
    pipelineName: 'doc_search',
    bindingRole: 'rewriter',
    description:
      'Query rewriter — produces 2-4 variants of the agent query (synonyms, decomposition, expansion) that are searched in parallel and merged via RRF. Anti-hallucination: variants must reuse terms from the original query or technical vocabulary. Opt-in via DOCS_RAG_REWRITE env flag.',
    recommendedDefault: {
      providerKind: 'cloudflare',
      modelHint: '@cf/meta/llama-3.1-8b-instruct',
      config: { temperature: 0.3, max_tokens: 400 },
    },
    introducedInPhase: '10',
  },
  {
    pipelineName: 'docs_research',
    bindingRole: 'scorer_llm',
    description:
      'DocsAgent — main LLM that drives multi-step retrieval: decides which collection to search, when to read full chunks, when to reformulate, and emits the structured docs_finish payload. Recommended: a strong reasoning model (Claude Sonnet, GPT-4o).',
    recommendedDefault: {
      providerKind: 'anthropic',
      modelHint: 'claude-sonnet-4',
      config: { temperature: 0.2 },
    },
    introducedInPhase: '10',
  },
  {
    pipelineName: 'docs_research',
    bindingRole: 'classifier',
    description:
      'DocsAgent — synthesizer LLM called by the docs_synthesize tool to render the final markdown with footnote citations. Lower-cost than the scorer_llm; recommended Llama-8B or GPT-4o-mini.',
    recommendedDefault: {
      providerKind: 'cloudflare',
      modelHint: '@cf/meta/llama-3.1-8b-instruct',
      config: { temperature: 0.1, max_tokens: 2000 },
    },
    introducedInPhase: '10',
  },
  {
    pipelineName: 'doc_ingest',
    bindingRole: 'link_extractor',
    description:
      'Extracts URLs that cheerio misses from seed pages — JS-rendered sidebars, data-attribute routes, embedded JSON page maps (__NEXT_DATA__, pageMap). Called once per source (seed only) when the source has `llm_extract_links` enabled. Anti-hallucination: returns ONLY URLs that literally appear in the HTML.',
    recommendedDefault: {
      providerKind: 'cloudflare',
      modelHint: '@cf/meta/llama-3.1-8b-instruct',
      config: { temperature: 0, max_tokens: 4000 },
    },
    introducedInPhase: '9',
  },

  // ─── Project memory (Mem C write-back) ───────────────────────────────────
  // Distills durable project memory from session summaries (decisions,
  // conventions, gotchas, procedure recipes). OPTIONAL override: when this
  // binding is unset, the pipeline falls back to the general default AI
  // model (Admin → General AI) so memory works zero-config; set it here to
  // force a cheaper/local model for distillation.
  {
    pipelineName: 'memory_extraction',
    bindingRole: 'distiller',
    description:
      'Distills durable project memory (decisions, conventions, gotchas, recipes) from session summaries at compaction / idle. Optional — when unset, falls back to the general default AI model (zero-config).',
    recommendedDefault: {
      providerKind: 'cloudflare',
      modelHint: '@cf/meta/llama-3.1-8b-instruct',
      config: { temperature: 0, max_tokens: 1200 },
    },
    introducedInPhase: 'memory',
  },

  // ─── Vision fallback (image → text) ──────────────────────────────────────
  // When the active chat model cannot see images (no 'image' input modality)
  // OR the composer "Describe images" flag is on, uploaded attachments and
  // tool screenshots (view_image / preview_screenshot) are routed through
  // THIS model, which emits an agent-directed semantic description that is
  // substituted for the image before the blind model is called. Pick a
  // strong vision model (GPT-4o, Gemini Flash, Claude Sonnet).
  {
    pipelineName: 'code-agent',
    bindingRole: 'vision',
    description:
      'Vision model that turns images into agent-directed text descriptions when the active model cannot see them (auto-fallback) or when the composer "Describe images" flag is on. The describing prompt is supplied by the agent (view_image.describe / preview_screenshot.lookFor) or, for composer attachments, taken from the user message.',
    recommendedDefault: {
      providerKind: 'openai',
      modelHint: 'gpt-4o-mini',
      config: { temperature: 0.2, max_tokens: 1200 },
    },
    introducedInPhase: 'vision-fallback',
  },
];

/**
 * Group catalog entries by pipeline name for the admin panel listing.
 */
export function groupCatalogByPipeline(): Map<string, PipelineCatalogEntry[]> {
  const map = new Map<string, PipelineCatalogEntry[]>();
  for (const entry of PIPELINE_CATALOG) {
    const existing = map.get(entry.pipelineName) ?? [];
    existing.push(entry);
    map.set(entry.pipelineName, existing);
  }
  return map;
}

export function findCatalogEntry(pipelineName: string, bindingRole: string): PipelineCatalogEntry | undefined {
  return PIPELINE_CATALOG.find(
    (e) => e.pipelineName === pipelineName && e.bindingRole === bindingRole,
  );
}
