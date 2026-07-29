import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import {
  assertContainedPath,
  assertPathHasNoLinksSync,
  calculateSessionMetricsSummary,
  newSessionId,
  type JsonValue,
  type SessionLocation,
  type SessionMetricsSummary,
  type SessionProjectionEntityWrite,
  type SessionState,
  type SessionId,
} from '@mcp/session-storage';
import {
  hydrateMessage,
  parseCoderTurnPayload,
  projectConversation,
  requestKey,
  toJsonValue,
} from './conversation-codec.js';
import { FsSessionEntityFiles } from './entity-files.js';
import { projectGoalState } from './goal-repository.js';
import { FsSessionDirectory } from './session-directory.js';
import { coderMetadata } from './session-projection.js';
import type {
  FsCoderTurnPayload,
  FsStoredMessage,
} from './types.js';

export interface FsRollbackAttachment {
  name: string;
  mediaType: string;
  path?: string;
  base64?: string;
  text?: string;
}

export interface FsRollbackResult {
  session: Awaited<ReturnType<FsSessionDirectory['getSession']>>;
  seed_text: string;
  seed_attachments: FsRollbackAttachment[];
  had_attachments: boolean;
}

interface RollbackCleanupProjection {
  readonly entities: readonly SessionProjectionEntityWrite[];
  readonly updateState: (state: SessionState) => SessionState;
}

interface RollbackMetricProjection {
  readonly entity: SessionProjectionEntityWrite | null;
  readonly summary: SessionMetricsSummary;
}

function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function seed(message: AgentMessage): {
  text: string;
  attachments: FsRollbackAttachment[];
} {
  const text = message.content
    .filter(
      (block): block is Extract<
        AgentMessage['content'][number],
        { type: 'text' }
      > => block.type === 'text',
    )
    .map((block) => block.text)
    .join('\n');
  const attachments = message.content.flatMap((block) => {
    if (block.type !== 'image' && block.type !== 'document') return [];
    if (
      block.type === 'document' &&
      block.path == null &&
      block.base64 == null &&
      block.text == null
    ) {
      return [];
    }
    return [{
      name:
        block.type === 'image'
          ? 'image.png'
          : block.name || 'document',
      mediaType:
        block.mediaType ||
        (block.type === 'image'
          ? 'image/png'
          : 'application/octet-stream'),
      ...(block.type === 'document' && block.path
        ? { path: block.path }
        : {}),
      ...(block.base64 ? { base64: block.base64 } : {}),
      ...(block.type === 'document' && block.text
        ? { text: block.text }
        : {}),
    }];
  });
  return { text, attachments };
}

function goalSnapshot(
  value: ReturnType<typeof projectGoalState>['goal'],
): JsonValue | null {
  if (!value) return null;
  return toJsonValue({
    id: value.id,
    text: value.text,
    status: value.status,
    budget_tokens: value.budget_tokens,
    completion_note: value.completion_note,
    created_at: value.created_at,
    updated_at: value.updated_at,
  });
}

export class FsSessionRollbackRepository {
  readonly #entities: FsSessionEntityFiles;

  constructor(private readonly directory: FsSessionDirectory) {
    this.#entities = new FsSessionEntityFiles(directory);
  }

  rollbackSessionToSeq(
    id: SessionId | string,
    targetSeq: number,
  ): Promise<FsRollbackResult> {
    if (!Number.isSafeInteger(targetSeq) || targetSeq < 1) {
      return Promise.reject(new RangeError('rollback seq must be positive'));
    }
    return this.directory.runMutation(id, async () => {
      const entry = await this.directory.requireEntry(id);
      const commits =
        this.directory.repository.readConversationSync(entry.location);
      const operationId = `rollback:${String(id)}:${targetSeq}`;
      const key = requestKey({
        type: 'rollback-session',
        target_seq: targetSeq,
      });
      const replayIndex = commits.findIndex(
        (commit) => commit.operation_id === operationId,
      );
      const sourceCommits =
        replayIndex >= 0 ? commits.slice(0, replayIndex) : commits;
      if (
        replayIndex >= 0 &&
        parseCoderTurnPayload(commits[replayIndex]!).request_key !== key
      ) {
        throw new Error(`${operationId} was committed with different input`);
      }
      const before = projectConversation(sourceCommits);
      const target = before.storedMessages.find(
        (message) => message.seq === targetSeq,
      );
      if (!target) {
        throw new Error(`message seq ${targetSeq} not in session`);
      }
      if (target.role !== 'user') {
        throw new Error(`message seq ${targetSeq} is not a user message`);
      }
      const hydrated = hydrateMessage(entry.location, target);
      let rollbackCommit = replayIndex >= 0 ? commits[replayIndex]! : null;
      if (!rollbackCommit) {
        const goal = projectGoalState(commits);
        const goalMutations = goal.goal
          ? [
              toJsonValue({
                id: newSessionId(),
                seq: goal.mutationSeq + 1,
                source: 'admin',
                tool_use_id: null,
                tool_name: null,
                expected: goalSnapshot(goal.goal),
                next: null,
              }),
            ]
          : [];
        const payload: FsCoderTurnPayload = {
          schema_version: 1,
          type: 'coder.turn',
          request_key: key,
          truncate_from_seq: targetSeq,
          messages: [],
          message_patches: [],
          tool_calls: [],
          goal_mutations: goalMutations,
        };
        rollbackCommit = await this.directory.repository.commitTurn(
          entry.location,
          {
            operation_id: operationId,
            payload: toJsonValue(payload),
            touch_session: false,
          },
        );
      }

      const cleanup = await this.#prepareCleanupWithinMutation(
        entry.session.id,
        targetSeq,
        operationId,
      );
      const metric = this.#prepareRollbackMetric(
        entry.location,
        rollbackCommit.seq,
        targetSeq,
        rollbackCommit.committed_at,
      );
      const remaining = projectConversation(
        replayIndex >= 0 ? commits : [...commits, rollbackCommit],
      );
      const lastAssistant = remaining.storedMessages
        .filter((message) => message.role === 'assistant')
        .at(-1);
      const projectionEntities = metric.entity
        ? [...cleanup.entities, metric.entity]
        : cleanup.entities;
      await this.directory.repository.updateProjectionBatch(entry.location, {
        update_session: (current) => {
          const coder = coderMetadata(current.metadata);
          return {
            ...current,
            metadata: {
              ...current.metadata,
              coder: toJsonValue({
                ...coder,
                usage: {
                  ...coder.usage,
                  last_turn_input_tokens:
                    lastAssistant?.usage.input_tokens ?? 0,
                },
              }),
            },
          };
        },
        update_state: cleanup.updateState,
        entities: projectionEntities,
        metrics_summary: metric.summary,
      });
      const session = await this.directory.getSession(entry.session.id);
      if (!session) {
        throw new Error(
          `Session ${entry.session.id} disappeared after rollback`,
        );
      }
      const seeded = seed(hydrated);
      return {
        session,
        seed_text: seeded.text,
        seed_attachments: seeded.attachments,
        had_attachments: seeded.attachments.length > 0,
      };
    });
  }

  async #prepareCleanupWithinMutation(
    sessionId: SessionId,
    targetSeq: number,
    operationId: string,
  ): Promise<RollbackCleanupProjection> {
    const now = new Date().toISOString();
    const [plans, tasks, chapters] = await Promise.all([
      this.#entities.list<JsonValue>(
        sessionId,
        'plans',
        'plan',
      ),
      this.#entities.list<JsonValue>(
        sessionId,
        'tasks',
      ),
      this.#entities.list<JsonValue>(
        sessionId,
        'chapters',
        'conversation_chapter',
      ),
    ]);
    const entities: SessionProjectionEntityWrite[] = [];
    for (const plan of plans) {
      const messageSeq = record(plan.data).message_seq;
      if (
        typeof messageSeq === 'number' &&
        messageSeq < targetSeq
      ) {
        continue;
      }
      const prepared = this.#entities.prepareUpdate(
        plan,
        'plans',
        (data) => data,
        {
          delete: true,
          operation_id: `${operationId}:plan:${plan.id}`,
          operation_key: { action: 'rollback_plan', target_seq: targetSeq },
        },
      );
      if (prepared?.changed) {
        entities.push({
          directory: 'plans',
          id: plan.id,
          value: toJsonValue(prepared.record),
        });
      }
    }

    for (const task of tasks) {
      const prepared = this.#entities.prepareUpdate(
        task,
        'tasks',
        (data) => data,
        {
          delete: true,
          operation_id: `${operationId}:task:${task.id}`,
          operation_key: { action: 'rollback_task', target_seq: targetSeq },
        },
      );
      if (prepared?.changed) {
        entities.push({
          directory: 'tasks',
          id: task.id,
          value: toJsonValue(prepared.record),
        });
      }
    }

    const surviving: Array<Record<string, unknown>> = [];
    for (const chapter of chapters) {
      const data = record(chapter.data);
      const end = data.end_message_seq;
      if (typeof end === 'number' && end < targetSeq) {
        if (
          data.superseded_at == null &&
          data.advances_context_boundary === 1
        ) {
          surviving.push(data);
        }
        continue;
      }
      const prepared = this.#entities.prepareUpdate<Record<string, unknown>>(
        chapter,
        'chapters',
        (current) => ({ ...current, superseded_at: now }),
        {
          operation_id: `${operationId}:chapter:${chapter.id}`,
          operation_key: {
            action: 'rollback_chapter',
            target_seq: targetSeq,
          },
        },
      );
      if (prepared?.changed) {
        entities.push({
          directory: 'chapters',
          id: chapter.id,
          value: toJsonValue(prepared.record),
        });
      }
    }
    const latestChapter = surviving.sort(
      (left, right) =>
        Number(right.end_message_seq) - Number(left.end_message_seq),
    )[0];
    const boundary = Number(latestChapter?.end_message_seq ?? 0);
    return {
      entities,
      updateState: (state) => {
        const runtime = record(state.extra.runtime);
        const memoryBoundary =
          typeof runtime.memory_distilled_seq === 'number'
            ? Math.min(runtime.memory_distilled_seq, targetSeq - 1)
            : 0;
        return {
          ...state,
          status: 'idle',
          goal: null,
          todos: [],
          compaction: {
            ...state.compaction,
            boundary_seq: boundary,
            summary:
              typeof latestChapter?.resume_text === 'string'
                ? latestChapter.resume_text
                : null,
            kind:
              typeof latestChapter?.chapter_kind === 'string'
                ? latestChapter.chapter_kind
                : null,
          },
          extra: {
            ...state.extra,
            runtime: {
              ...runtime,
              last_response_id: null,
              last_response_message_count: null,
              cloudcode_session_id: null,
              pending_agent_transition: null,
              memory_distilled_seq: memoryBoundary,
            },
          },
        };
      },
    };
  }

  #prepareRollbackMetric(
    location: SessionLocation,
    turnSeq: number,
    targetSeq: number,
    recordedAt: string,
  ): RollbackMetricProjection {
    const id = `rollback-${turnSeq}`;
    const target = join(
      location.bundle_path,
      'metrics',
      'turns',
      `${id}.json`,
    );
    assertContainedPath(location.bundle_path, target);
    if (existsSync(target)) {
      assertPathHasNoLinksSync(location.bundle_path, target);
      return {
        entity: null,
        summary: calculateSessionMetricsSummary(location.bundle_path),
      };
    }
    const zeroUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    };
    const value = toJsonValue({
      schema_version: 1,
      metric_kind: 'conversation_rollback',
      turn_seq: turnSeq,
      message_seq: targetSeq,
      truncate_from_message_seq: targetSeq,
      turns: 0,
      tool_calls: 0,
      usage: zeroUsage,
      subagent_usage: zeroUsage,
      recorded_at: recordedAt,
    });
    return {
      entity: {
        directory: 'metrics/turns',
        id,
        value,
      },
      summary: calculateSessionMetricsSummary(
        location.bundle_path,
        new Date().toISOString(),
        [value],
      ),
    };
  }
}

export type FsSessionRollbackApi = Pick<
  FsSessionRollbackRepository,
  'rollbackSessionToSeq'
>;

export function installSessionRollbackApi(
  target: object,
  directory: FsSessionDirectory,
): void {
  const repository = new FsSessionRollbackRepository(directory);
  Object.defineProperty(target, 'rollbackSessionToSeq', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: repository.rollbackSessionToSeq.bind(repository),
  });
}
