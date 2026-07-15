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
    setupEligible: false, // cross-encoder, not an LLM-as-reranker
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
    setupEligible: false, // informational only — no runtime effect
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
      'Selective-recall filter (Claude-Code pattern): a cheap LLM pass that keeps only the retrieved project ' +
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

  // ─── Goal completion verifier (Claude-Code stop-condition pattern) ───────
  // An INDEPENDENT read-only second agent that confirms the ORIGINAL goal was
  // actually met (goal + plan + diff + tests) before the run is allowed to
  // finish — the "stop-condition verifier" half of CC's two-agent split.
  // Gated behind CODER_GOAL_VERIFY; unset binding → falls back to the general
  // default AI model so it works zero-config. Prefer a strong reasoning model,
  // ideally a DIFFERENT family than the executor so it doesn't share blind spots.
  {
    pipelineName: 'goal_verification',
    bindingRole: 'reviewer',
    description:
      'Independent completion verifier: a read-only second agent that confirms the original goal was ' +
      'actually achieved (goal+plan+diff+tests) before the run finishes. Gated behind CODER_GOAL_VERIFY. ' +
      'Pick a strong reasoning model — ideally a different family than the executor. Unset → general default AI model.',
    recommendedDefault: {
      providerKind: 'anthropic',
      modelHint: 'claude-sonnet-4',
      config: { temperature: 0, max_tokens: 1500, json_mode: true },
    },
    introducedInPhase: 'cc-gap-A1',
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

  // ─── Sprite Studio (2D sprite generation) ────────────────────────────────
  // Powers the Sprite Studio surface (/sprites) and the sprite_* agent tools.
  // The image_gen binding picks WHICH image model generates/edits sprites —
  // image models are the provider rows discovered with mode='image' (families:
  // gpt-image-*, dall-e-*, gemini *-image / nano banana). Never pin a version
  // here: bind the best image model your provider currently discovers.
  {
    pipelineName: 'sprite-studio',
    bindingRole: 'image_gen',
    description:
      'Image model that generates and edits sprites (txt2img + reference-conditioned edits). ' +
      'Pick a model row with mode=image — e.g. the newest gpt-image-* on OpenAI (native transparency + mask inpaint) ' +
      'or the newest Gemini image / nano banana model (best cheap character consistency). ' +
      'Add more bindings as failover links; the job runner skips links that lack a required capability ' +
      '(e.g. edit-with-references). Config knobs: size, quality, n.',
    recommendedDefault: {
      providerKind: 'openai',
      modelHint: 'newest gpt-image-* discovered (mode=image)',
      config: { size: '1024x1024', quality: 'medium' },
    },
    introducedInPhase: 'sprite-studio',
  },
  {
    pipelineName: 'sprite-studio',
    bindingRole: 'prompt_expander',
    description:
      'Cheap text LLM that fuses the user intent + the sprite project style profile (palette, perspective, ' +
      'outline, proportions) into the final image prompt. Unset = deterministic template fallback (intent + style suffix).',
    recommendedDefault: {
      providerKind: 'cloudflare',
      modelHint: '@cf/meta/llama-3.1-8b-instruct',
      config: { temperature: 0.2, max_tokens: 500 },
    },
    introducedInPhase: 'sprite-studio',
  },
  {
    pipelineName: 'sprite-studio',
    bindingRole: 'vision',
    description:
      'Vision model for character-consistency audits ("same character? list differences") against the asset\'s ' +
      'anchor reference. Unset = falls back to the code-agent vision binding.',
    recommendedDefault: {
      providerKind: 'openai',
      modelHint: 'gpt-4o-mini',
      config: { temperature: 0, max_tokens: 800 },
    },
    introducedInPhase: 'sprite-studio',
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
