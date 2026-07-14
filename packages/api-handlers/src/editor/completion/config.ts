/**
 * Knob parsing for the editor autocomplete handler — one place that turns the
 * binding's free-form `config` JSON into typed values with the documented
 * defaults. Every knob is optional; unknown/invalid values fall back.
 */

export interface ResolvedCompletionCfg {
  contextEngine: 'v3' | 'v2' | 'v1';
  contextMode: 'layered' | 'imports_only';
  budgetTokens: number;
  sourceTimeoutMs: number;
  deadlineMs: number;
  cacheTtlMs: number;
  lspMemberRaceMs: number;
  toggles: { recentEdits: boolean; openTabs: boolean; lspDefs: boolean; relatedCode: boolean };
  relatedCodeTokens: number;
  jaccardMinScore: number;
  maxTabFiles: number;
  maxPrefixLines: number;
  maxSuffixLines: number;
  timeoutMs: number;
  debounceMs: number;
  /** 'auto' (default) = per-position heuristic (completion/multiline.ts). */
  multilineMode: boolean | 'auto';
  disableThinkingOverride: boolean | undefined;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/** Default context budgets: FIM prompts tolerate more context than chat. */
const BUDGET_FIM_TOK = 2500;
const BUDGET_CHAT_TOK = 1200;

export function parseCompletionCfg(
  cfg: Record<string, unknown>,
  endpoint: 'fim' | 'chat',
): ResolvedCompletionCfg {
  // Token budget: explicit tokens knob → legacy chars knob (÷3.5) → per-endpoint auto.
  const legacyChars = num(cfg.context_budget_chars, 0);
  const budgetTokens = num(
    cfg.context_budget_tokens,
    legacyChars > 0 ? Math.round(legacyChars / 3.5) : endpoint === 'fim' ? BUDGET_FIM_TOK : BUDGET_CHAT_TOK,
  );
  return {
    contextEngine: cfg.context_engine === 'v1' ? 'v1' : cfg.context_engine === 'v2' ? 'v2' : 'v3',
    contextMode: cfg.context_mode === 'imports_only' ? 'imports_only' : 'layered',
    budgetTokens,
    sourceTimeoutMs: num(cfg.context_source_timeout_ms, 100),
    deadlineMs: num(cfg.context_deadline_ms, 150),
    cacheTtlMs: num(cfg.context_cache_ttl_ms, 10_000),
    lspMemberRaceMs: num(cfg.lsp_member_race_ms, 250),
    toggles: {
      recentEdits: bool(cfg.ctx_recent_edits, true),
      openTabs: bool(cfg.ctx_open_tabs, true),
      lspDefs: bool(cfg.ctx_lsp_defs, true),
      // Both flags are required. Existing bindings therefore stay off until
      // the admin explicitly accepts the cross-file context notice.
      relatedCode: cfg.ctx_related_code === true && cfg.ctx_related_code_consent_v === 1,
    },
    relatedCodeTokens: Math.min(700, num(cfg.ctx_related_code_tokens, 700)),
    jaccardMinScore: num(cfg.jaccard_min_score, 0.1),
    maxTabFiles: num(cfg.max_tab_files, 10),
    maxPrefixLines: num(cfg.max_prefix_lines, 80),
    maxSuffixLines: num(cfg.max_suffix_lines, 30),
    // 8s ceiling: reasoning/big coder chat models routinely take >3s to first
    // token; the FIM presets set 4000 explicitly in the binding config.
    timeoutMs: num(cfg.timeout_ms, 8000),
    debounceMs: num(cfg.debounce_ms, 300),
    multilineMode: cfg.multiline === true || cfg.multiline === false ? cfg.multiline : 'auto',
    disableThinkingOverride: typeof cfg.disable_thinking === 'boolean' ? cfg.disable_thinking : undefined,
  };
}
