import { randomUUID } from 'node:crypto';
import {
  SessionOperationConflictError,
  type ConversationCommit,
  type JsonValue,
  type SessionLocation,
  type ToolOutputRecord,
  type WriterProjection,
} from '@mcp/session-storage';
import {
  parseCoderTurnPayload,
  prepareMessage,
  ConversationProjection,
  requestKey,
  toJsonValue,
  usageRecord,
} from './conversation-codec.js';
import { FsSessionDirectory } from './session-directory.js';
import {
  buildToolCallRecord,
  buildToolResultMessage,
} from './tool-codec.js';
import type {
  FsAppendMessageInput,
  FsAppendMessageUsage,
  FsAppendToolCallInput,
  FsCoderTurnPayload,
  FsPersistAssistantTurnInput,
  FsStoredMessage,
  FsToolCallInput,
  FsToolCallRecord,
} from './types.js';

function operationId(input: { operation_id?: string }, prefix: string): string {
  const value = input.operation_id ?? `${prefix}:${randomUUID()}`;
  if (value.trim().length === 0 || value.length > 512 || value.includes('\0')) {
    throw new TypeError('operation_id must be a non-empty opaque string');
  }
  return value;
}

function assistantOperationId(input: FsPersistAssistantTurnInput): string {
  if (input.operation_id) return operationId(input, 'assistant');
  // `run_id` identifies the whole agent run, not one assistant turn. Using it
  // here made every tool-bearing turn after the first collide with the first
  // JSONL commit. A provider tool-use id is scoped to one assistant message,
  // so it is a safe idempotency identity for callers that do not supply the
  // stronger explicit per-turn operation_id.
  const stable =
    input.tool_calls[0]?.tool_use_id ??
    input.nested_tool_calls?.[0]?.tool_use_id;
  return stable
    ? operationId({ operation_id: `assistant:tool:${stable}` }, 'assistant')
    : operationId({}, 'assistant');
}

function toolMetadata(
  input: FsToolCallInput,
): Readonly<Record<string, JsonValue>> {
  const {
    result_text: _resultText,
    raw_result: _rawResult,
    shaped_result: _shapedResult,
    args: _args,
    ...metadata
  } = input;
  return toJsonValue(metadata) as Readonly<Record<string, JsonValue>>;
}

const writeProjection: WriterProjection<ConversationProjection> = {
  create: () => new ConversationProjection(),
  apply: (state, commit) => state.apply(commit),
};

export class FsConversationWriter {
  constructor(private readonly directory: FsSessionDirectory) {}

  private replay(
    projection: ConversationProjection,
    operation: string,
    key: string,
  ): FsCoderTurnPayload | null {
    const existing = projection.findCommit(operation);
    if (!existing) return null;
    const payload = parseCoderTurnPayload(existing);
    if (payload.request_key !== key) {
      throw new SessionOperationConflictError(
        `operation_id ${operation} was already committed with different input`,
      );
    }
    return payload;
  }

  async appendMessage(input: FsAppendMessageInput): Promise<number> {
    return this.directory.runMutation(input.session_id, async () => {
      const entry = await this.directory.requireEntry(input.session_id);
      const prepared = prepareMessage(
        entry.location,
        input.message,
        input.usage,
      );
      const operation = operationId(input, 'message');
      const key = requestKey({
        type: 'append-message',
        message: prepared.stored,
      });
      const projection = await this.directory.repository.readWriterProjection(entry.location, writeProjection);
      const replay = this.replay(projection, operation, key);
      if (replay) {
        const previous = replay.messages[0];
        if (!previous) {
          throw new SessionOperationConflictError(
            `operation_id ${operation} has no message result`,
          );
        }
        return previous.seq;
      }
      const seq = projection.highestMessageSeq + 1;
      const message: FsStoredMessage = {
        ...prepared.stored,
        id: randomUUID(),
        seq,
      };
      const payload: FsCoderTurnPayload = {
        schema_version: 1,
        type: 'coder.turn',
        request_key: key,
        messages: [message],
        message_patches: [],
        tool_calls: [],
      };
      const commit = await this.directory.repository.commitTurn(entry.location, {
        operation_id: operation,
        payload: toJsonValue(payload),
        artifacts: prepared.artifacts,
      });
      await this.writeTurnMetric(
        entry.location,
        commit.seq,
        seq,
        1,
        0,
        input.usage,
      );
      return seq;
    });
  }

  private async persistToolOutput(
    location: SessionLocation,
    input: FsToolCallInput,
  ): Promise<ToolOutputRecord> {
    return this.directory.repository.writeToolOutput(location, {
      call_id: input.tool_use_id,
      ...(input.raw_result === undefined
        ? {}
        : { raw: input.raw_result }),
      shaped: input.shaped_result ?? input.result_text,
      media_type: 'text/plain; charset=utf-8',
      metadata: {
        tool_name: input.tool_name,
        is_error: input.is_error,
        duration_ms: input.duration_ms,
        ...toolMetadata(input),
      },
    });
  }

  async appendToolCall(input: FsAppendToolCallInput): Promise<void> {
    await this.directory.runMutation(input.session_id, async () => {
      const entry = await this.directory.requireEntry(input.session_id);
      const projection = await this.directory.repository.readWriterProjection(entry.location, writeProjection);
      if (
        !projection.hasMessage(input.message_seq)
      ) {
        throw new Error(`Unknown message seq ${input.message_seq}`);
      }
      const operation = operationId(
        {
          operation_id:
            input.operation_id ?? `tool-call:${input.tool_use_id}`,
        },
        'tool-call',
      );
      const key = requestKey({
        type: 'append-tool-call',
        message_seq: input.message_seq,
        call: input,
      });
      if (this.replay(projection, operation, key)) return;
      const output = await this.persistToolOutput(entry.location, input);
      const call = buildToolCallRecord(
        input.message_seq,
        input,
        output,
        input.parent_tool_use_id != null,
      );
      const payload: FsCoderTurnPayload = {
        schema_version: 1,
        type: 'coder.turn',
        request_key: key,
        messages: [],
        message_patches: [],
        tool_calls: [call],
      };
      const commit = await this.directory.repository.commitTurn(entry.location, {
        operation_id: operation,
        payload: toJsonValue(payload),
      });
      await this.writeTurnMetric(
        entry.location,
        commit.seq,
        input.message_seq,
        0,
        1,
      );
    });
  }

  async persistAssistantTurn(
    input: FsPersistAssistantTurnInput,
  ): Promise<number> {
    return this.directory.runMutation(input.session_id, async () => {
      const entry = await this.directory.requireEntry(input.session_id);
      const prepared = prepareMessage(
        entry.location,
        input.message,
        input.usage,
      );
      const operation = assistantOperationId(input);
      const key = requestKey({
        type: 'persist-assistant-turn',
        message: prepared.stored,
        tool_calls: input.tool_calls,
        nested_tool_calls: input.nested_tool_calls ?? [],
        existing_message_seq: input.existing_message_seq ?? null,
        // Keep the neutral v1 request fingerprint stable when retrying a
        // pre-removal turn. These retired fields never enter the new payload.
        goal_mutations: [],
        goal_noop_tool_use_ids: [],
      });
      const projection = await this.directory.repository.readWriterProjection(entry.location, writeProjection);
      const replay = this.replay(projection, operation, key);
      if (replay) {
        const seq =
          replay.message_patches[0]?.seq ??
          replay.messages.find((message) => message.role === 'assistant')?.seq ??
          input.existing_message_seq;
        if (seq == null) {
          throw new SessionOperationConflictError(
            `operation_id ${operation} has no assistant message result`,
          );
        }
        return seq;
      }

      const existingSeq = input.existing_message_seq;
      if (
        existingSeq != null &&
        !projection.hasMessage(existingSeq, 'assistant')
      ) {
        throw new Error(
          `existing_message_seq ${existingSeq} is not an assistant message`,
        );
      }
      const allInputs = [
        ...input.tool_calls,
        ...(input.nested_tool_calls ?? []),
      ];
      const ids = allInputs.map((call) => call.tool_use_id);
      if (new Set(ids).size !== ids.length) {
        throw new TypeError('Assistant turn contains duplicate tool_use_id values');
      }
      const outputs = await Promise.all(
        allInputs.map((call) => this.persistToolOutput(entry.location, call)),
      );
      const highest = projection.highestMessageSeq;
      const assistantSeq = existingSeq ?? highest + 1;
      const allCalls = [
        ...input.tool_calls.map((call) => ({ call, nested: false })),
        ...(input.nested_tool_calls ?? []).map((call) => ({
          call,
          nested: true,
        })),
      ];
      const toolCalls: FsToolCallRecord[] = allCalls.map(
        ({ call, nested }, index) =>
          buildToolCallRecord(assistantSeq, call, outputs[index], nested),
      );
      const topLevelCalls = toolCalls.filter((call) => !call.nested);
      // Context is display metadata. Keep the request key compatible with
      // retries of turns written before the measurement was persisted.
      if (input.context) prepared.stored.usage.context = input.context;
      const messages: FsStoredMessage[] = [];
      const patches = [];
      if (existingSeq == null) {
        messages.push({
          ...prepared.stored,
          id: randomUUID(),
          seq: assistantSeq,
        });
      } else {
        patches.push({
          seq: assistantSeq,
          content: prepared.stored.content,
          usage: prepared.stored.usage,
          artifact_refs: prepared.stored.artifact_refs,
        });
      }
      if (topLevelCalls.length > 0) {
        messages.push(
          buildToolResultMessage(
            Math.max(highest, assistantSeq) + 1,
            topLevelCalls,
          ),
        );
      }

      const payload: FsCoderTurnPayload = {
        schema_version: 1,
        type: 'coder.turn',
        request_key: key,
        messages,
        message_patches: patches,
        tool_calls: toolCalls,
      };
      const commit = await this.directory.repository.commitTurn(entry.location, {
        operation_id: operation,
        payload: toJsonValue(payload),
        artifacts: prepared.artifacts,
        // bumpUsage below durably writes session.json, including updated_at.
        // Do not first flush a second copy that differs only in its timestamp.
        touch_session: false,
      });
      await this.writeTurnMetric(
        entry.location,
        commit.seq,
        assistantSeq,
        1,
        toolCalls.length,
        input.usage,
        input.subagent_usage,
      );
      await this.directory.bumpUsage(
        entry.location,
        input.usage,
        input.subagent_usage,
      );
      return assistantSeq;
    });
  }

  private async writeTurnMetric(
    location: SessionLocation,
    turnSeq: number,
    messageSeq: number,
    turns: number,
    toolCalls: number,
    usage?: FsAppendMessageUsage | null,
    subagentUsage?: FsAppendMessageUsage | null,
  ): Promise<void> {
    await this.directory.repository.writeEntity(
      location,
      'metrics/turns',
      `turn-${turnSeq}`,
      toJsonValue({
        schema_version: 1,
        turn_seq: turnSeq,
        message_seq: messageSeq,
        turns,
        tool_calls: toolCalls,
        usage: usageRecord(usage),
        subagent_usage: usageRecord(subagentUsage),
        recorded_at: new Date().toISOString(),
      }),
    );
  }
}
