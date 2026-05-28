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
export const SYSTEM_PROMPT_VERSION = '20260528.1';

export interface AssembleSystemPromptArgs {
  basePrompt: string;
  qualitySuffix: string;
}

export function assembleSystemPrompt(args: AssembleSystemPromptArgs): string {
  if (!args.qualitySuffix) return args.basePrompt;
  return `${args.basePrompt}${args.qualitySuffix}`;
}
