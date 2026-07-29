import { randomUUID } from 'node:crypto';
import type {
  ArtifactRef,
  JsonValue,
  ToolOutputRecord,
} from '@mcp/session-storage';
import { toJsonValue, usageRecord } from './conversation-codec.js';
import type {
  FsStoredMessage,
  FsToolCallInput,
  FsToolCallRecord,
} from './types.js';

interface StoredToolResultBlock {
  type: 'tool_result_ref';
  tool_use_id: string;
  output: ToolOutputRecord;
  is_error: boolean;
  truncated?: boolean;
  original_size?: number;
}

export function buildToolCallRecord(
  messageSeq: number,
  input: FsToolCallInput,
  output: ToolOutputRecord,
  nested: boolean,
): FsToolCallRecord {
  const {
    result_text: _resultText,
    raw_result: _rawResult,
    shaped_result: _shapedResult,
    args,
    tool_use_id,
    tool_name,
    is_error,
    duration_ms,
    ...metadata
  } = input;
  return {
    schema_version: 1,
    id: randomUUID(),
    message_seq: messageSeq,
    tool_use_id,
    tool_name,
    args: toJsonValue(args),
    is_error,
    duration_ms,
    nested,
    output,
    metadata: toJsonValue(metadata) as Readonly<Record<string, JsonValue>>,
  };
}

export function buildToolResultMessage(
  seq: number,
  calls: readonly FsToolCallRecord[],
): FsStoredMessage {
  const blocks: StoredToolResultBlock[] = calls.map((call) => ({
    type: 'tool_result_ref',
    tool_use_id: call.tool_use_id,
    output: call.output,
    is_error: call.is_error,
    ...(call.metadata.truncated === true
      ? {
          truncated: true,
          original_size:
            typeof call.metadata.output_chars === 'number'
              ? call.metadata.output_chars
              : undefined,
        }
      : {}),
  }));
  return {
    schema_version: 1,
    id: randomUUID(),
    seq,
    role: 'tool',
    content: toJsonValue(blocks),
    usage: usageRecord(null),
    is_meta: false,
    selected_skill_ids: [],
    artifact_refs: calls.flatMap((call) =>
      [call.output.raw, call.output.shaped].filter(
        (ref): ref is ArtifactRef => ref != null,
      ),
    ),
  };
}
