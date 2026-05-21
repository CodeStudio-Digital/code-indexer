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
  | 'link_extractor';

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
    description: 'Embeddings used for the docs vector store. Can differ from the indexer_search embedder.',
    recommendedDefault: { providerKind: 'cloudflare', modelHint: '@cf/baai/bge-m3' },
    introducedInPhase: '9',
  },
  {
    pipelineName: 'doc_search',
    bindingRole: 'reranker',
    description: 'Optional cross-encoder reranker for the top-K chunks before they are returned to the agent.',
    introducedInPhase: '9',
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
