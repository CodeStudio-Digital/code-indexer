export type PersistedGoalStatus = 'in_progress' | 'complete' | 'superseded';

export interface PersistedGoalSnapshot {
  text: string;
  status: PersistedGoalStatus;
  budget_tokens: number | null;
  completion_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface PersistedGoalMutation {
  tool_use_id: string;
  tool_name: 'create_goal' | 'update_goal';
  expected: PersistedGoalSnapshot | null;
  next: PersistedGoalSnapshot;
}

export interface GoalMutationToolCall {
  tool_use_id: string;
  tool_name: string;
  is_error: boolean;
}

export interface GoalTurnEvidence {
  successfulGoalToolUseIds: string[];
  missingGoalMutationIds: string[];
  failedStagedGoalMutationIds: string[];
  mutationsToApply: PersistedGoalMutation[];
}

const GOAL_TOOL_NAMES = new Set(['create_goal', 'update_goal']);
const evidenceKey = (toolUseId: string, toolName: string): string =>
  `${toolUseId}\0${toolName}`;

/**
 * Pair successful goal tool evidence with the mutations committed by the
 * filesystem turn writer. Persistence itself belongs to the bundle writer;
 * this module deliberately contains no database adapter.
 */
export function auditGoalTurnEvidence(
  toolCalls: readonly GoalMutationToolCall[],
  stagedMutations: readonly PersistedGoalMutation[],
  noopToolUseIds: ReadonlySet<string> = new Set(),
): GoalTurnEvidence {
  const successfulGoalToolUseIds = toolCalls
    .filter((call) => GOAL_TOOL_NAMES.has(call.tool_name) && !call.is_error)
    .map((call) => call.tool_use_id);
  const successfulKeys = new Set(
    toolCalls
      .filter((call) => !call.is_error)
      .map((call) => evidenceKey(call.tool_use_id, call.tool_name)),
  );
  const mutationsToApply = stagedMutations.filter((mutation) =>
    successfulKeys.has(evidenceKey(mutation.tool_use_id, mutation.tool_name)),
  );
  const appliedIds = new Set(
    mutationsToApply.map((mutation) => mutation.tool_use_id),
  );
  return {
    successfulGoalToolUseIds,
    missingGoalMutationIds: successfulGoalToolUseIds.filter(
      (toolUseId) =>
        !appliedIds.has(toolUseId) && !noopToolUseIds.has(toolUseId),
    ),
    failedStagedGoalMutationIds: stagedMutations
      .map((mutation) => mutation.tool_use_id)
      .filter((toolUseId) => !appliedIds.has(toolUseId)),
    mutationsToApply,
  };
}

export function samePersistedGoalSnapshot(
  actual: PersistedGoalSnapshot | null,
  expected: PersistedGoalSnapshot | null,
): boolean {
  if (actual == null || expected == null) return actual === expected;
  return (
    actual.text === expected.text
    && actual.status === expected.status
    && actual.budget_tokens === expected.budget_tokens
    && actual.completion_note === expected.completion_note
    && actual.created_at === expected.created_at
    && actual.updated_at === expected.updated_at
  );
}
