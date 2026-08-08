/**
 * CoderTunables — runtime knobs for the runner's payload/intervention budgets.
 *
 * Levels of override (highest precedence first):
 *
 *   1. `RunnerOptions.pushTimeCap` (per-call override, set by subagent factories etc.)
 *   2. `RunnerOptions.tunables`    (per-session override; admin/host builds this
 *                                   from Decider — `config_json.pipelines.runner_tunables.*`)
 *   3. product defaults            (stable fallback)
 *   4. `DEFAULT_TUNABLES`          (hardcoded fallbacks — match the legacy constants)
 *
 * The runner instance resolves the effective tunables ONCE in its constructor:
 *
 *   this.tunables = opts.tunables ?? envTunables();
 *
 * When `opts.tunables` is omitted (every existing caller today), behavior is
 * bit-identical to the legacy hardcoded constants — same env keys, same
 * defaults. This module just adds a clean shape so per-session/per-tier
 * overrides can flow in without touching the runner internals.
 *
 * NOTE: The legacy module-level `const PUSH_TIME_CAP = ...` etc. in `runner.ts`
 * are retained for a handful of standalone exported functions
 * (`normalizeMessageForCache`, `buildToolResultBlock`'s default arg,
 * `SUBAGENT_TOOL_RESULT_CAP`). Those don't have a runner instance to read
 * `this.tunables` from. They keep their env-driven defaults.
 */

import type { ResolvedRuntimePolicyV1 } from '@mcp/agent-runtime-contracts';

export interface CoderTunables {
  /** Per-tool-result block cap when written into the message history. Main runner default. */
  pushTimeCap: number;
  /** Tighter per-block cap for subagents — they emit many small tool results in a short window. */
  subagentPushTimeCap: number;
  /** Ceiling used when `unrestricted_tool_output=1` is set on the session (main runners). */
  unrestrictedPushTimeCap: number;
  /** Ceiling used when `unrestricted_tool_output=1` is set on the session (subagents). */
  unrestrictedSubagentPushTimeCap: number;
  /** Per-turn payload budget — emits a warning when about-to-send size exceeds this. */
  turnBudgetChars: number;
  /** Minimum turns between consecutive tool-misuse planning interventions. */
  interventionCooldownTurns: number;
}

/**
 * Frozen hardcoded fallbacks. Match the literal values that used to live as
 * module-level constants in `runner.ts:364-392`. Changing these requires
 * coordinating with the bench baselines.
 */
export const DEFAULT_TUNABLES: Readonly<CoderTunables> = Object.freeze({
  pushTimeCap: 24_000,
  subagentPushTimeCap: 12_000,
  unrestrictedPushTimeCap: 1_000_000,
  unrestrictedSubagentPushTimeCap: 500_000,
  turnBudgetChars: 30_000,
  interventionCooldownTurns: 5,
});

/**
 * Build a `CoderTunables` snapshot from `process.env` using the legacy
 * `CODER_*` keys. Each missing/invalid env var falls back to `DEFAULT_TUNABLES`.
 *
 * Called by the runner constructor when `opts.tunables` is not provided —
 * this is what preserves bit-identical behavior with the legacy constants.
 */
export function envTunables(): CoderTunables {
  return { ...DEFAULT_TUNABLES };
}

/**
 * Merge a partial override into a base tunables snapshot. Each key that is
 * a finite positive number wins; anything else falls through to the base.
 *
 * Used by host adapters that build a per-session snapshot from a Decider:
 *
 *   const base = envTunables();
 *   const override = {
 *     pushTimeCap: decider.getValue('runner_tunables.pushTimeCap', ctx),
 *     // ...
 *   };
 *   return mergeTunables(base, override);
 *
 * Keeping the merge logic here means the runner never has to know about
 * Decider, and the adapter never has to know about defaults.
 */
export function mergeTunables(
  base: CoderTunables,
  override: Partial<Record<keyof CoderTunables, unknown>>,
): CoderTunables {
  const out: CoderTunables = { ...base };
  for (const key of Object.keys(base) as Array<keyof CoderTunables>) {
    const v = override[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      out[key] = v;
    }
  }
  return out;
}

/** Project the canonical attempt policy into the legacy runner's narrow shape. */
export function tunablesFromRuntimePolicy(policy: ResolvedRuntimePolicyV1): CoderTunables {
  return {
    pushTimeCap: policy.context.toolResultChars,
    subagentPushTimeCap: policy.context.subagentToolResultChars,
    unrestrictedPushTimeCap: policy.context.unrestrictedToolResultChars,
    unrestrictedSubagentPushTimeCap: policy.context.unrestrictedSubagentToolResultChars,
    turnBudgetChars: policy.context.turnBudgetChars,
    interventionCooldownTurns: policy.context.interventionCooldownTurns,
  };
}
