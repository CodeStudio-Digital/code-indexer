/**
 * Shared SQL predicates for coder_tool_calls guard telemetry.
 *
 * Every consumer aliases coder_tool_calls as `tc`. Keeping the predicates in
 * one place prevents the diagnostics endpoint and telemetry summaries from
 * silently assigning the same propagated code_exec failure to different
 * categories.
 */
export const PROPAGATED_PARENT_FAILURE_SQL = `
  tc.parent_tool_use_id IS NULL
  AND tc.guard_origin_tool_use_id IS NOT NULL
  AND tc.guard_origin_tool_use_id <> tc.tool_use_id
  AND (tc.guard_action = 'block' OR tc.refusal_kind IS NOT NULL)`;

export const REFUSAL_SQL = `
  (tc.refusal_kind IS NOT NULL OR tc.guard_action = 'block')`;

export const ROOT_REFUSAL_SQL = `
  (${REFUSAL_SQL} AND NOT (${PROPAGATED_PARENT_FAILURE_SQL}))`;

export const GENUINE_ERROR_SQL = `
  (tc.is_error = 1
   AND tc.refusal_kind IS NULL
   AND COALESCE(tc.guard_action, '') <> 'block'
   AND NOT (${PROPAGATED_PARENT_FAILURE_SQL}))`;

export const REUSE_SQL = `(tc.guard_action = 'reuse')`;

export const SHADOW_CANDIDATE_SQL = `
  (tc.guard_action = 'shadow'
   OR (tc.would_block = 1 AND COALESCE(tc.guard_action, '') <> 'block'))`;
