/**
 * Catalog of configurable pipelines and their provider-binding roles.
 *
 * The admin UI uses this list to render the bindings panel — each entry
 * appears as a row even before any binding row exists in the DB. Adding a
 * new pipeline here is the FIRST step when introducing a new pipeline:
 * it shows up in the admin panel, the admin sets a provider+model, then
 * the pipeline code uses `PipelineProviderResolver.resolve(name, role)`.
 *
 * Semantic-profile-owned embeddings/rerankers and retired historical
 * bindings do not belong here: listing them made the admin UI report a
 * configured provider/model even though runtime ignored the row.
 */

export type BindingRole =
  | 'embedder'
  | 'classifier'
  | 'reranker'
  | 'scorer_llm'
  | 'hyde'
  | 'compaction_llm'
  | 'compaction'
  | 'link_extractor'
  | 'rewriter'
  | 'reviewer'
  | 'vision'
  | 'transcription'
  | 'distiller'
  | 'preflight'
  | 'autocomplete'
  | 'image_gen'
  | 'prompt_expander'
  | 'query_writer';

/**
 * Coarse, layperson-facing capability bucket a binding role belongs to.
 * Drives the admin filter facets and the guided-setup wizard fan-out.
 * Fully determined by the role (1:1) — see {@link ROLE_CAPABILITY}.
 */
export type CapabilityKind =
  | 'text_llm'
  | 'embeddings'
  | 'reranking'
  | 'vision'
  | 'voice'
  | 'autocomplete'
  | 'image_gen';

/**
 * Role → capability bucket. The `satisfies Record<BindingRole, …>` makes
 * this exhaustive: adding a new BindingRole without a bucket here is a
 * compile error — the safety net the admin UI + setup endpoint rely on.
 */
const ROLE_CAPABILITY = {
  embedder: 'embeddings',
  classifier: 'text_llm',
  reranker: 'reranking',
  scorer_llm: 'text_llm',
  hyde: 'text_llm',
  compaction_llm: 'text_llm',
  compaction: 'text_llm',
  link_extractor: 'text_llm',
  rewriter: 'text_llm',
  reviewer: 'text_llm',
  vision: 'vision',
  transcription: 'voice',
  distiller: 'text_llm',
  preflight: 'text_llm',
  autocomplete: 'autocomplete',
  image_gen: 'image_gen',
  prompt_expander: 'text_llm',
  query_writer: 'text_llm',
} satisfies Record<BindingRole, CapabilityKind>;

export function capabilityKindForRole(role: BindingRole): CapabilityKind {
  return ROLE_CAPABILITY[role];
}

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
  /** Layperson capability bucket (filled by the catalog builder). */
  capabilityKind: CapabilityKind;
  /**
   * Whether the guided-setup wizard may bind this entry. Defaults to true.
   * Set false for entries that are informational (no runtime effect) or
   * whose role expects a different model TYPE than the bucket implies
   * (e.g. a cross-encoder reranker, not an LLM-as-reranker).
   */
  setupEligible?: boolean;
}

/** Authoring shape — `capabilityKind` is derived, not hand-written. */
type CatalogSeed = Omit<PipelineCatalogEntry, 'capabilityKind'>;

const CATALOG_SEED: CatalogSeed[] = [
  // ─── Existing indexer pipeline (Phase 1 — extracted) ─────────────────────
  // Embeddings and reranking are configured exclusively through the Code
  // semantic profile. HyDE remains an optional text-LLM pipeline binding.
  {
    pipelineName: 'indexer_search',
    bindingRole: 'hyde',
    description:
      'Optional query expansion for semantic code search. This single binding selects the provider and model used by HyDE; leave it unconfigured or disabled to make no LLM call.',
    recommendedDefault: {
      providerKind: 'cloudflare',
      modelHint: '@cf/meta/llama-3.2-3b-instruct',
      config: { temperature: 0.2, max_tokens: 180, timeout_ms: 20000 },
    },
    introducedInPhase: '1',
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
  // Compiles the session intent (title + first message + task list) into
  // structured, verifiable obligations the snapshot review joins against the
  // hunks — detecting unfulfilled work and scope creep. One cheap call,
  // cached per intent hash (session_intent_contracts, migration 224).
  {
    pipelineName: 'intent_contract',
    bindingRole: 'reviewer',
    description:
      'Compiles the session intent into verifiable obligations for the snapshot review ' +
      '(unfulfilled_obligation / scope_creep detection). Cheap call, cached per intent hash.',
    recommendedDefault: {
      providerKind: 'anthropic',
      modelHint: 'claude-haiku-4-5-20251001',
      config: { temperature: 0, max_tokens: 1200, json_mode: true },
    },
    introducedInPhase: 'review-ai-native',
  },

  // ─── Documentação (RAG) pipelines (Phase 9) ──────────────────────────────
  // Backs the "Documentação" sidebar feature: per-collection RAG over
  // user-curated docs (PDF + URL crawls). The crawl gate uses a cheap
  // classifier to keep/drop pages before paying for enrichment.
  // The classifier and enricher remain ordinary LLM pipeline bindings.
  // Embeddings and reranking are intentionally absent from pipeline setup:
  // their only source of truth is the Code/Knowledge semantic profile.
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
      // 4000 — a JSON array of memories truncated mid-item parses as empty;
      // thinking-capable models need the headroom (distill-call also clamps).
      config: { temperature: 0, max_tokens: 4000 },
    },
    introducedInPhase: 'memory',
  },
  {
    pipelineName: 'memory_recall',
    bindingRole: 'reranker',
    description:
      'Independent LLM selective-recall filter (not the semantic-profile cross-encoder): keeps only the retrieved project ' +
      'memories CLEARLY about the current task (aboutness, not keyword overlap; ≤5; conservative with user-profile). ' +
      'Gated by CODER_MEMORY_LLM_FILTER. Unset → no LLM filtering (the structural relevance floor still applies).',
    recommendedDefault: {
      providerKind: 'cloudflare',
      modelHint: '@cf/meta/llama-3.1-8b-instruct',
      config: { temperature: 0, max_tokens: 200 },
    },
    introducedInPhase: 'cc-gap-D1',
  },
  {
    pipelineName: 'memory_query',
    bindingRole: 'query_writer',
    description:
      'Memory-recall query writer: a cheap LLM pass that turns a meta/continuation message ' +
      '("continue", "reanalise tudo que fez") plus the recent conversation into ONE short search ' +
      'query describing the task in progress, so proactive memory recall stops missing on task-less ' +
      'turns. Optional — unset falls back to a pure walk-back heuristic (last substantive message).',
    recommendedDefault: {
      providerKind: 'cloudflare',
      modelHint: '@cf/meta/llama-3.1-8b-instruct',
      config: { temperature: 0, max_tokens: 100 },
    },
    introducedInPhase: 'memory-query',
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

  // ─── Speech-to-text (audio → text) ───────────────────────────────────────
  // Powers the composer microphone button: recorded audio is transcribed by
  // THIS model and the transcript is inserted into the message input. Uses an
  // OpenAI-compatible POST {base_url}/audio/transcriptions endpoint (Whisper
  // style). Unset = the mic button stays disabled with a hint to configure it.
  {
    pipelineName: 'code-agent',
    bindingRole: 'transcription',
    description:
      'Speech-to-text (STT) for the composer mic button. Two provider kinds work: (1) Google Gemini (e.g. gemini-2.5-flash / -flash-lite) — transcribes via its native multimodal API; (2) OpenAI-Whisper-compatible endpoints (POST {base_url}/audio/transcriptions) — OpenAI whisper-1, Groq whisper-large-v3 (free + fast), local whisper.cpp/faster-whisper. Unset = the mic button stays disabled.',
    recommendedDefault: {
      providerKind: 'openai',
      modelHint: 'whisper-1',
      config: { response_format: 'json', temperature: 0 },
    },
    introducedInPhase: 'voice-to-text',
  },

  // ─── Task preflight (first-prompt analysis) ──────────────────────────────
  // When bound, the FIRST user prompt of a fresh coder chat session is
  // analyzed by this cheap model BEFORE the agent starts: it picks the
  // smallest tool profile, up to a dozen tools to pin, and which project
  // memories the agent should read (titles only). The result seeds the
  // session toolset and is injected as a <preflight> hint on turn 1.
  // Unset = feature off (sessions start exactly as before). Fail-open:
  // timeouts/errors never block the session.
  {
    pipelineName: 'code-agent',
    bindingRole: 'preflight',
    description:
      'Cheap model that analyzes the FIRST user prompt of a fresh coder session and seeds it: minimal tool profile, pinned tools, and which project memories to read (titles only, injected as a <preflight> hint). Unset = off; failures never block the session.',
    recommendedDefault: {
      providerKind: 'cloudflare',
      modelHint: '@cf/meta/llama-3.1-8b-instruct',
      config: { temperature: 0, max_tokens: 700 },
    },
    introducedInPhase: 'task-preflight',
  },

  // ─── Conversation compaction / chapter summaries ───────────────────────
  // Optional cheap-model override for the hot-path summary that closes a
  // conversation chapter. Unset deliberately falls back to the chat model so
  // existing installs remain zero-config.
  {
    pipelineName: 'code-agent',
    bindingRole: 'compaction',
    description:
      'Low-cost deterministic model used to summarize a compacted conversation span into an immutable chapter plus the bounded resume state. Unset = reuse the active chat provider/model.',
    recommendedDefault: {
      providerKind: 'openai',
      modelHint: 'gpt-4o-mini',
      config: { temperature: 0, max_tokens: 1500, reasoning_effort: 'minimal', timeout_ms: 45000 },
    },
    introducedInPhase: 'conversation-chapters',
  },

  // ─── Editor inline autocomplete (ghost text) ─────────────────────────────
  // Powers the editor's AI ghost-text suggestions. Privacy warning lives in
  // the description because the code around the cursor IS sent to the bound
  // provider on every (debounced) request. Unset = the editor chip shows
  // "not configured" and no request is ever made. Knobs are read by the
  // editor handler from config (not by the chat layer).
  {
    pipelineName: 'editor',
    bindingRole: 'autocomplete',
    description:
      'Inline AI code completion (ghost text) in the editor. PRIVACY: code around the cursor is sent on each suggestion; indexed cross-file examples are sent only when ctx_related_code=true AND ctx_related_code_consent_v=1. Prefer native/template FIM models. Generic chat is manual-only (Alt+\\) until the project-free 3-prompt completion probe meets p50<=750ms and p90<=1500ms; allow_degraded_auto=true is an explicit override. Reasoning is minimized and OAuth streams are locally stopped after a useful line/block. Unset = feature unavailable. Config knobs: max_tokens, temperature, debounce_ms, multiline, max_prefix_lines, max_suffix_lines, timeout_ms, disable_thinking, fim, fim_template, allow_degraded_auto. Context engine: context_engine ("v3" default, "v2"/"v1" kill-switches), context_budget_tokens, context_source_timeout_ms (100), context_deadline_ms (150), context_cache_ttl_ms, lsp_member_race_ms (250), ctx_recent_edits / ctx_open_tabs / ctx_lsp_defs, ctx_related_code, ctx_related_code_consent_v, ctx_related_code_tokens (capped at 700), jaccard_min_score and max_tab_files.',
    recommendedDefault: {
      providerKind: 'mistral',
      modelHint: 'codestral-latest',
      config: {
        temperature: 0.05,
        max_tokens: 256,
        max_tokens_single_line: 64,
        aggressiveness: 'balanced',
        multiline: 'auto',
        max_prefix_lines: 80,
        max_suffix_lines: 30,
        timeout_ms: 4000,
        context_engine: 'v3',
      },
    },
    introducedInPhase: 'editor-autocomplete',
  },

];

/**
 * Public catalog — every entry enriched with its derived `capabilityKind`.
 * Deriving here (vs hand-writing 44 literals) guarantees the role→bucket
 * map can never drift from the entries.
 */
export const PIPELINE_CATALOG: PipelineCatalogEntry[] = CATALOG_SEED.map((e) => ({
  ...e,
  capabilityKind: capabilityKindForRole(e.bindingRole),
}));

/**
 * Catalog entries the guided-setup wizard should bind for a capability
 * bucket: same bucket, real (not coming-soon), and setup-eligible.
 */
export function setupTargetsForCapability(kind: CapabilityKind): PipelineCatalogEntry[] {
  return PIPELINE_CATALOG.filter(
    (e) => e.capabilityKind === kind && e.setupEligible !== false && !e.comingSoon,
  );
}

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
