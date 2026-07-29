/**
 * Adapter that builds a `CoderTunables` snapshot from the Decider chain
 * (A1 finalization — Sprint 1 closeout).
 *
 * Layering:
 *   `@mcp/code-agent/core/tunables` — pure constants + env reading. NO
 *   knowledge of Decider. Owns `CoderTunables`, `envTunables`,
 *   `mergeTunables`, `DEFAULT_TUNABLES`.
 *
 *   `@mcp/services/pipelines/decider` — Decider chain (ConfigJson/Env/
 *   Constant/Composite). NO knowledge of tunables.
 *
 *   This file — the glue: takes a Decider + ctx, reads the
 *   `runner_tunables.*` keys, merges over `envTunables()`. Lives in
 *   services so neither code-agent nor decider needs to import the
 *   other (avoids the cross-package dep).
 *
 * Used by `apps/http-api/server/deps.ts` and `apps/cli/commands/agent.ts`
 * when constructing `RunCoderOptions.tunables`. Default behavior
 * (no plumbing): the runner falls back to `envTunables()` which falls
 * back to `DEFAULT_TUNABLES` — bit-identical to pre-A1 constants.
 *
 * Decider keys honored (all optional, finite positive number):
 *   - `runner_tunables.pushTimeCap`
 *   - `runner_tunables.subagentPushTimeCap`
 *   - `runner_tunables.unrestrictedPushTimeCap`
 *   - `runner_tunables.unrestrictedSubagentPushTimeCap`
 *   - `runner_tunables.turnBudgetChars`
 *   - `runner_tunables.interventionCooldownTurns`
 *
 * Example admin usage (writes to the session bundle configuration):
 *   {
 *     "pipelines": {
 *       "runner_tunables": {
 *         "pushTimeCap": 48000,
 *         "turnBudgetChars": 60000
 *       }
 *     }
 *   }
 */
import {
  envTunables,
  mergeTunables,
  type CoderTunables,
} from '@mcp/code-agent/core/tunables.js';
import type { Decider, DeciderContext } from './decider.js';

const TUNABLE_KEYS: ReadonlyArray<keyof CoderTunables> = [
  'pushTimeCap',
  'subagentPushTimeCap',
  'unrestrictedPushTimeCap',
  'unrestrictedSubagentPushTimeCap',
  'turnBudgetChars',
  'interventionCooldownTurns',
];

/**
 * Build a `CoderTunables` by reading Decider values for each `runner_tunables.*`
 * key, falling through to `envTunables()` for absent/invalid values.
 *
 * Pure function — `decider.getValue` is called per key, no caching here.
 * Callers that need to amortize repeated lookups should pre-compute once
 * per session and pass into `RunCoderOptions.tunables`.
 */
export function tunablesFromDecider(decider: Decider, ctx: DeciderContext): CoderTunables {
  const base = envTunables();
  const override: Partial<Record<keyof CoderTunables, unknown>> = {};
  for (const key of TUNABLE_KEYS) {
    const value = decider.getValue<unknown>(`runner_tunables.${key}`, ctx);
    if (value !== undefined) override[key] = value;
  }
  return mergeTunables(base, override);
}
