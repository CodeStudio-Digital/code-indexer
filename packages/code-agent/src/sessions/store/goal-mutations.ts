import type { Database as DB } from 'better-sqlite3';

export type PersistedGoalStatus = 'in_progress' | 'complete' | 'superseded';

export interface PersistedGoalSnapshot {
  text: string;
  status: PersistedGoalStatus;
  budget_tokens: number | null;
  completion_note: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * One session-goal state transition paired with the direct tool invocation
 * that authorized it. A turn may contain two mutations (the canonical
 * update_goal(superseded) + create_goal pivot batch); they are applied in
 * order inside the same transaction as their tool evidence.
 */
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

interface GoalRow {
  goal_text: string | null;
  goal_status: string | null;
  goal_budget_tokens: number | null;
  goal_completion_note: string | null;
  goal_created_at: string | null;
  goal_updated_at: string | null;
}

function snapshotFromRow(row: GoalRow): PersistedGoalSnapshot | null {
  if (
    row.goal_text == null
    && row.goal_status == null
    && row.goal_budget_tokens == null
    && row.goal_completion_note == null
    && row.goal_created_at == null
    && row.goal_updated_at == null
  ) {
    return null;
  }
  if (
    row.goal_text == null
    || (
      row.goal_status !== 'in_progress'
      && row.goal_status !== 'complete'
      && row.goal_status !== 'superseded'
    )
    || row.goal_created_at == null
    || row.goal_updated_at == null
  ) {
    throw new Error('goal persistence invariant failed: stored goal is incomplete');
  }
  return {
    text: row.goal_text,
    status: row.goal_status,
    budget_tokens: row.goal_budget_tokens,
    completion_note: row.goal_completion_note,
    created_at: row.goal_created_at,
    updated_at: row.goal_updated_at,
  };
}

export function samePersistedGoalSnapshot(
  actual: PersistedGoalSnapshot | null,
  expected: PersistedGoalSnapshot | null,
): boolean {
  if (actual == null || expected == null) return actual === expected;
  return actual.text === expected.text
    && actual.status === expected.status
    && actual.budget_tokens === expected.budget_tokens
    && actual.completion_note === expected.completion_note
    && actual.created_at === expected.created_at
    && actual.updated_at === expected.updated_at;
}

export function readPersistedGoalSnapshot(
  db: DB,
  sessionId: number,
): PersistedGoalSnapshot | null {
  const row = db.prepare(`
    SELECT goal_text, goal_status, goal_budget_tokens, goal_completion_note,
           goal_created_at, goal_updated_at
      FROM coder_sessions
     WHERE id = ?
  `).get(sessionId) as GoalRow | undefined;
  if (!row) {
    throw new Error(`goal persistence invariant failed: session ${sessionId} is missing`);
  }
  return snapshotFromRow(row);
}

function validateMutation(mutation: PersistedGoalMutation): void {
  if (mutation.tool_name === 'create_goal') {
    if (
      mutation.next.status !== 'in_progress'
      || mutation.next.completion_note !== null
      || mutation.expected?.status === 'in_progress'
    ) {
      throw new Error(
        `goal mutation ${mutation.tool_use_id} is not a valid create_goal transition`,
      );
    }
    return;
  }
  if (
    mutation.expected?.status !== 'in_progress'
    || (
      mutation.next.status !== 'complete'
      && mutation.next.status !== 'superseded'
    )
    || (
      mutation.next.status === 'superseded'
      && !mutation.next.completion_note?.trim()
    )
    || mutation.next.text !== mutation.expected.text
    || mutation.next.created_at !== mutation.expected.created_at
    || mutation.next.budget_tokens !== mutation.expected.budget_tokens
  ) {
    throw new Error(
      `goal mutation ${mutation.tool_use_id} is not a valid update_goal transition`,
    );
  }
}

/**
 * Apply goal mutations inside the caller's transaction.
 *
 * The optimistic snapshot comparison is the generation fence: a delayed
 * completion cannot close a replacement objective, and a create cannot
 * overwrite a concurrently-created goal. Throwing rolls back the assistant
 * row, tool audit rows, paired tool message, usage and goal state together.
 */
export function applyGoalMutations(
  db: DB,
  sessionId: number,
  toolCalls: readonly GoalMutationToolCall[],
  mutations: readonly PersistedGoalMutation[],
): void {
  if (mutations.length === 0) return;
  const seenToolIds = new Set<string>();
  const writeGoal = db.prepare(`
    UPDATE coder_sessions
       SET goal_text = ?,
           goal_status = ?,
           goal_budget_tokens = ?,
           goal_completion_note = ?,
           goal_created_at = ?,
           goal_updated_at = ?,
           updated_at = datetime('now')
     WHERE id = ?
  `);

  for (const mutation of mutations) {
    if (seenToolIds.has(mutation.tool_use_id)) {
      throw new Error(`duplicate goal mutation tool_use_id ${mutation.tool_use_id}`);
    }
    seenToolIds.add(mutation.tool_use_id);
    validateMutation(mutation);

    const matchingCall = toolCalls.some(
      (call) =>
        call.tool_use_id === mutation.tool_use_id
        && call.tool_name === mutation.tool_name
        && !call.is_error,
    );
    if (!matchingCall) {
      throw new Error(
        `goal mutation ${mutation.tool_use_id} has no successful ${mutation.tool_name} in the persisted turn`,
      );
    }

    const actual = readPersistedGoalSnapshot(db, sessionId);
    if (!samePersistedGoalSnapshot(actual, mutation.expected)) {
      throw new Error(
        `goal mutation ${mutation.tool_use_id} lost its expected objective`,
      );
    }

    const changed = writeGoal.run(
      mutation.next.text,
      mutation.next.status,
      mutation.next.budget_tokens,
      mutation.next.completion_note,
      mutation.next.created_at,
      mutation.next.updated_at,
      sessionId,
    );
    if (changed.changes !== 1) {
      throw new Error(`goal mutation ${mutation.tool_use_id} targets a missing session`);
    }
  }
}
