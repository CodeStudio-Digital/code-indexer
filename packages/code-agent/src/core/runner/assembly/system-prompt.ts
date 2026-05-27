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

export interface AssembleSystemPromptArgs {
  basePrompt: string;
  qualitySuffix: string;
}

export function assembleSystemPrompt(args: AssembleSystemPromptArgs): string {
  if (!args.qualitySuffix) return args.basePrompt;
  return `${args.basePrompt}${args.qualitySuffix}`;
}
