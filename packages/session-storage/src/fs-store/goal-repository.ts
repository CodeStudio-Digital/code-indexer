import {
  newSessionId,
  type ConversationCommit,
  type JsonValue,
  type SessionId,
} from '@mcp/session-storage';
import {
  parseCoderTurnPayload,
  requestKey,
  toJsonValue,
} from './conversation-codec.js';
import { FsSessionDirectory } from './session-directory.js';
import type {
  FsCoderTurnPayload,
  FsToolCallInput,
} from './types.js';
import type {
  FsGoalMutation,
  FsGoalSnapshot,
  FsGoalStatus,
  FsSessionGoal,
  FsUpsertGoalInput,
} from './operational-types.js';

export class FsGoalConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FsGoalConflictError';
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function status(value: unknown): FsGoalStatus {
  if (
    value !== 'in_progress' &&
    value !== 'complete' &&
    value !== 'superseded'
  ) {
    throw new TypeError(`Invalid goal status ${String(value)}`);
  }
  return value;
}

function snapshot(
  value: unknown,
  fallbackId?: string,
): FsGoalSnapshot | null {
  if (value == null) return null;
  const candidate = record(value);
  if (
    !candidate ||
    typeof candidate.text !== 'string' ||
    typeof candidate.created_at !== 'string' ||
    typeof candidate.updated_at !== 'string'
  ) {
    throw new TypeError('Invalid goal snapshot');
  }
  return {
    id:
      typeof candidate.id === 'string'
        ? candidate.id
        : fallbackId ?? newSessionId(),
    text: candidate.text,
    status: status(candidate.status),
    budget_tokens:
      typeof candidate.budget_tokens === 'number'
        ? candidate.budget_tokens
        : null,
    completion_note:
      typeof candidate.completion_note === 'string'
        ? candidate.completion_note
        : null,
    created_at: candidate.created_at,
    updated_at: candidate.updated_at,
  };
}

function sameSnapshot(
  left: FsGoalSnapshot | null,
  right: FsGoalSnapshot | null,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.id === right.id &&
    left.text === right.text &&
    left.status === right.status &&
    left.budget_tokens === right.budget_tokens &&
    left.completion_note === right.completion_note &&
    left.created_at === right.created_at &&
    left.updated_at === right.updated_at
  );
}

function mutation(value: JsonValue): FsGoalMutation {
  const item = record(value);
  if (
    !item ||
    typeof item.id !== 'string' ||
    !Number.isSafeInteger(item.seq) ||
    (item.source !== 'tool' && item.source !== 'admin')
  ) {
    throw new TypeError('Invalid persisted goal mutation');
  }
  return {
    id: item.id,
    seq: item.seq as number,
    source: item.source,
    tool_use_id:
      typeof item.tool_use_id === 'string' ? item.tool_use_id : null,
    tool_name:
      item.tool_name === 'create_goal' || item.tool_name === 'update_goal'
        ? item.tool_name
        : null,
    expected: snapshot(item.expected),
    next: snapshot(item.next),
  };
}

function apply(
  current: FsSessionGoal | null,
  nextMutation: FsGoalMutation,
): FsSessionGoal | null {
  const actual = current
    ? {
        id: current.id,
        text: current.text,
        status: current.status,
        budget_tokens: current.budget_tokens,
        completion_note: current.completion_note,
        created_at: current.created_at,
        updated_at: current.updated_at,
      }
    : null;
  if (!sameSnapshot(actual, nextMutation.expected)) {
    throw new FsGoalConflictError(
      `goal mutation ${nextMutation.id} lost its expected objective`,
    );
  }
  return nextMutation.next
    ? {
        ...nextMutation.next,
        revision: (current?.revision ?? 0) + 1,
        mutation_seq: nextMutation.seq,
      }
    : null;
}

export interface FsGoalProjection {
  goal: FsSessionGoal | null;
  mutationSeq: number;
}

export function projectGoalState(
  commits: readonly ConversationCommit[],
): FsGoalProjection {
  const projection: FsGoalProjection = { goal: null, mutationSeq: 0 };
  for (const commit of commits) {
    advanceGoalProjection(projection, commit);
  }
  return projection;
}

export function advanceGoalProjection(projection: FsGoalProjection, commit: ConversationCommit): void {
  for (const raw of parseCoderTurnPayload(commit).goal_mutations) {
    const nextMutation = mutation(raw);
    const expectedSeq = projection.mutationSeq + 1;
    if (nextMutation.seq !== expectedSeq) {
      throw new FsGoalConflictError(`goal mutation seq ${nextMutation.seq} expected ${expectedSeq}`);
    }
    projection.goal = apply(projection.goal, nextMutation);
    projection.mutationSeq = expectedSeq;
  }
}

export function projectGoal(
  commits: readonly ConversationCommit[],
): FsSessionGoal | null {
  return projectGoalState(commits).goal;
}

function validateTransition(
  current: FsSessionGoal | null,
  next: FsGoalSnapshot,
  toolName: 'create_goal' | 'update_goal',
): void {
  if (toolName === 'create_goal') {
    if (next.status !== 'in_progress' || next.completion_note != null) {
      throw new FsGoalConflictError('create_goal must create an in-progress goal');
    }
    if (current?.status === 'in_progress') {
      throw new FsGoalConflictError('create_goal cannot replace an in-progress goal');
    }
    return;
  }
  if (
    current?.status !== 'in_progress' ||
    (next.status !== 'complete' && next.status !== 'superseded') ||
    next.text !== current.text ||
    next.created_at !== current.created_at ||
    next.budget_tokens !== current.budget_tokens ||
    (next.status === 'superseded' && !next.completion_note?.trim())
  ) {
    throw new FsGoalConflictError('invalid update_goal transition');
  }
}

export function prepareTurnGoalMutations(
  current: FsSessionGoal | null,
  toolCalls: readonly FsToolCallInput[],
  rawMutations: readonly unknown[],
  noopToolUseIds: ReadonlySet<string> = new Set(),
  startingMutationSeq = current?.mutation_seq ?? 0,
): FsGoalMutation[] {
  let projected = current;
  let mutationSeq = startingMutationSeq;
  const successful = new Map(
    toolCalls
      .filter((call) => !call.is_error)
      .map((call) => [call.tool_use_id, call.tool_name]),
  );
  const out: FsGoalMutation[] = [];
  for (const raw of rawMutations) {
    const candidate = record(raw);
    if (!candidate) throw new TypeError('Goal mutation must be an object');
    const toolUseId =
      typeof candidate.tool_use_id === 'string'
        ? candidate.tool_use_id
        : null;
    const toolName =
      candidate.tool_name === 'create_goal' ||
      candidate.tool_name === 'update_goal'
        ? candidate.tool_name
        : null;
    if (
      !toolUseId ||
      !toolName ||
      successful.get(toolUseId) !== toolName
    ) {
      throw new FsGoalConflictError(
        `goal mutation ${toolUseId ?? 'unknown'} lacks successful tool evidence`,
      );
    }
    const actual = projected
      ? {
          id: projected.id,
          text: projected.text,
          status: projected.status,
          budget_tokens: projected.budget_tokens,
          completion_note: projected.completion_note,
          created_at: projected.created_at,
          updated_at: projected.updated_at,
        }
      : null;
    const expected = snapshot(candidate.expected, actual?.id);
    if (!sameSnapshot(actual, expected)) {
      throw new FsGoalConflictError(
        `goal mutation ${toolUseId} lost its expected objective`,
      );
    }
    const next = snapshot(
      candidate.next,
      toolName === 'update_goal' ? actual?.id : undefined,
    );
    if (!next) throw new TypeError('Tool goal mutation requires next state');
    validateTransition(projected, next, toolName);
    const prepared: FsGoalMutation = {
      id: newSessionId(),
      seq: ++mutationSeq,
      source: 'tool',
      tool_use_id: toolUseId,
      tool_name: toolName,
      expected,
      next,
    };
    projected = apply(projected, prepared);
    out.push(prepared);
  }
  const applied = new Set(out.map((item) => item.tool_use_id));
  const missing = toolCalls.find(
    (call) =>
      !call.is_error &&
      (call.tool_name === 'create_goal' || call.tool_name === 'update_goal') &&
      !applied.has(call.tool_use_id) &&
      !noopToolUseIds.has(call.tool_use_id),
  );
  if (missing) {
    throw new FsGoalConflictError(
      `successful ${missing.tool_name} ${missing.tool_use_id} lacks a goal mutation`,
    );
  }
  return out;
}

export class FsGoalRepository {
  constructor(private readonly directory: FsSessionDirectory) {}

  async get(id: SessionId | string): Promise<FsSessionGoal | null> {
    const entry = await this.directory.requireEntry(id);
    return projectGoal(
      this.directory.repository.readConversationSync(entry.location),
    );
  }

  upsert(
    id: SessionId | string,
    input: FsUpsertGoalInput,
  ): Promise<FsSessionGoal> {
    return this.directory.runMutation(id, async () => {
      const entry = await this.directory.requireEntry(id);
      const commits = this.directory.repository.readConversationSync(
        entry.location,
      );
      const operationId =
        input.operation_id ?? `goal-admin:${newSessionId()}`;
      const key = requestKey({ type: 'goal-upsert', input });
      const replayIndex = commits.findIndex(
        (commit) => commit.operation_id === operationId,
      );
      if (replayIndex >= 0) {
        const replay = commits[replayIndex];
        if (parseCoderTurnPayload(replay).request_key !== key) {
          throw new FsGoalConflictError(
            `operation_id ${operationId} has different goal input`,
          );
        }
        const replayed = projectGoal(commits.slice(0, replayIndex + 1));
        if (!replayed) {
          throw new FsGoalConflictError(
            `operation_id ${operationId} has no goal result`,
          );
        }
        return replayed;
      }
      const projection = projectGoalState(commits);
      const current = projection.goal;
      if (
        input.expected_revision != null &&
        (current?.revision ?? 0) !== input.expected_revision
      ) {
        throw new FsGoalConflictError(
          `goal expected revision ${input.expected_revision}, got ${current?.revision ?? 0}`,
        );
      }
      const next: FsGoalSnapshot = {
        id: current?.id ?? newSessionId(),
        text: input.text,
        status: input.status,
        budget_tokens: input.budgetTokens ?? null,
        completion_note: input.completionNote ?? null,
        created_at: current?.created_at ?? input.createdAt,
        updated_at: input.updatedAt,
      };
      const goalMutation: FsGoalMutation = {
        id: newSessionId(),
        seq: projection.mutationSeq + 1,
        source: 'admin',
        tool_use_id: null,
        tool_name: null,
        expected: current,
        next,
      };
      const payload: FsCoderTurnPayload = {
        schema_version: 1,
        type: 'coder.turn',
        request_key: key,
        messages: [],
        message_patches: [],
        tool_calls: [],
        goal_mutations: [toJsonValue(goalMutation)],
      };
      await this.directory.repository.commitTurn(entry.location, {
        operation_id: operationId,
        payload: toJsonValue(payload),
      });
      return (await this.get(id))!;
    });
  }

  clear(
    id: SessionId | string,
    options: { expected_revision?: number; operation_id?: string } = {},
  ): Promise<boolean> {
    return this.directory.runMutation(id, async () => {
      const entry = await this.directory.requireEntry(id);
      const commits = this.directory.repository.readConversationSync(
        entry.location,
      );
      const operationId =
        options.operation_id ?? `goal-clear:${newSessionId()}`;
      const key = requestKey({
        type: 'goal-clear',
        expected_revision: options.expected_revision ?? null,
      });
      const replay = commits.find(
        (commit) => commit.operation_id === operationId,
      );
      if (replay) {
        if (parseCoderTurnPayload(replay).request_key !== key) {
          throw new FsGoalConflictError(
            `operation_id ${operationId} has different goal input`,
          );
        }
        return true;
      }
      const projection = projectGoalState(commits);
      const current = projection.goal;
      if (!current) return false;
      if (
        options.expected_revision != null &&
        current.revision !== options.expected_revision
      ) {
        throw new FsGoalConflictError(
          `goal expected revision ${options.expected_revision}, got ${current.revision}`,
        );
      }
      const goalMutation: FsGoalMutation = {
        id: newSessionId(),
        seq: projection.mutationSeq + 1,
        source: 'admin',
        tool_use_id: null,
        tool_name: null,
        expected: current,
        next: null,
      };
      const payload: FsCoderTurnPayload = {
        schema_version: 1,
        type: 'coder.turn',
        request_key: key,
        messages: [],
        message_patches: [],
        tool_calls: [],
        goal_mutations: [toJsonValue(goalMutation)],
      };
      await this.directory.repository.commitTurn(entry.location, {
        operation_id: operationId,
        payload: toJsonValue(payload),
      });
      return true;
    });
  }
}
