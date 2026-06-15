/**
 * System prompt assembly — placeholder for Commit 2.
 *
 * Today the runner concatenates `this.opts.systemPrompt` with the quality
 * feedback suffix produced by `buildQualityFeedbackSuffix`. That helper
 * has side-effects (writes to QualityInterventionStore) and depends on
 * mutable runner state — refactoring it into a pure function requires
 * threading the intervention-store callbacks through args, which is
 * properly the work of Commit 4/5.
 *
 * For now this file only exposes the trivial concatenation helper so the
 * BT's `Executing` node can use a single import point once the quality
 * feedback path is migrated.
 */

/**
 * Version stamp embedded in every `coder_task_run_items.inputs_fingerprint`
 * (PR-D). Bump manually whenever the master/subagent system prompts change
 * in a way that should invalidate the skip-stale cache — adding a new
 * tool to the bootstrap list, changing the implement subagent's framing,
 * tightening sandboxing rules, etc.
 *
 * Format: YYYYMMDD.NN (NN counts changes inside the same day, starting 1).
 */
// Frente D bump — `execute_task` (singular) removed from the registry,
// `update_task` promoted to BOOTSTRAP_TOOLS. Old fingerprints must
// invalidate so PR-D's skip-stale gate re-runs anything that depended
// on the old tool surface.
// P1 bump — goal tools (create_goal/get_goal/update_goal) + update_todo
// promoted from silent bootstrap fallback to explicit BOOTSTRAP_TOOLS.
// 2026-06-05.2 bump — prompt accuracy/consistency pass: product name (MCP IDE),
// memory via save_memory (navigate), execute_tasks flow, current kanban tool
// names, master-vs-subordinate builder scoping, refreshed bootstrap tier-hint
// list. Static prefix changed → invalidate stale fingerprints.
// 2026-06-05.3 bump — added the gated "Session working memory" section
// (save_note/list_notes/read_plan/recall_investigations) for non-company sessions.
// 2026-06-12.1 bump — Fase 1 da redução do prompt: re-read/preambles enxutos
// (runner já enforça dedup), plan.txt sem allowlist enumerada e sem duplicar
// o lifecycle de tasks, subagents/overlay/tierHint/not-indexed comprimidos,
// memória unificada ({{memorySection}}), "Images & vision" condicional a
// modelCanSeeImages. Static prefix mudou → invalida fingerprints stale.
export const SYSTEM_PROMPT_VERSION = '20260612.1';

export interface AssembleSystemPromptArgs {
  basePrompt: string;
  qualitySuffix: string;
}

export function assembleSystemPrompt(args: AssembleSystemPromptArgs): string {
  if (!args.qualitySuffix) return args.basePrompt;
  return `${args.basePrompt}${args.qualitySuffix}`;
}
