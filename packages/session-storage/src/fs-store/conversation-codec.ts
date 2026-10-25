import type { AgentMessage, ContentBlock } from '@mcp/provider-sdk';
import {
  ArtifactStore,
  canonicalJson,
  computeRequestHash,
  isUuid,
  type ArtifactInput,
  type ArtifactRef,
  type ConversationCommit,
  type JsonValue,
  type SessionLocation,
  type ToolOutputRecord,
} from '@mcp/session-storage';
import type {
  FsAppendMessageUsage,
  FsCoderTurnPayload,
  FsPreparedMessage,
  FsStoredMessage,
  FsStoredMessagePatch,
  FsToolCallRecord,
} from './types.js';

export interface ProjectedStoredMessage extends FsStoredMessage {
  turn_seq: number;
  operation_id: string;
  committed_at: string;
}

export interface FsConversationProjection {
  storedMessages: ProjectedStoredMessage[];
  toolCalls: FsToolCallRecord[];
  commits: readonly ConversationCommit[];
  /** Highest sequence ever committed, including rows hidden by rollback. */
  highestMessageSeq: number;
}

interface StoredArtifactBlock {
  type: 'artifact_ref';
  source_type: 'image' | 'document';
  encoding: 'base64' | 'utf8';
  artifact: ArtifactRef;
  media_type: string;
  name?: string;
  path?: string;
  describe_hint?: string;
}

interface StoredToolResultBlock {
  type: 'tool_result_ref';
  tool_use_id: string;
  output: ToolOutputRecord;
  is_error: boolean;
  effect_outcome?: 'unknown';
  truncated?: boolean;
  original_size?: number;
}

export class FsConversationFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FsConversationFormatError';
  }
}

export function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(canonicalJson(value)) as JsonValue;
}

export function usageRecord(
  usage: FsAppendMessageUsage | null | undefined,
): FsStoredMessage['usage'] {
  return {
    input_tokens: usage?.input_tokens ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
    cache_read_tokens: usage?.cache_read_input_tokens ?? 0,
    cache_creation_tokens: usage?.cache_creation_input_tokens ?? 0,
  };
}

function decodeBase64(value: string, label: string): Uint8Array {
  const compact = value.replaceAll(/\s/g, '');
  if (
    compact.length === 0 ||
    compact.length % 4 === 1 ||
    !/^[a-z0-9+/]*={0,2}$/i.test(compact)
  ) {
    throw new TypeError(`Invalid base64 in ${label}`);
  }
  const bytes = Buffer.from(compact, 'base64');
  if (
    bytes.length === 0 ||
    bytes.toString('base64').replaceAll('=', '') !== compact.replaceAll('=', '')
  ) {
    throw new TypeError(`Invalid base64 in ${label}`);
  }
  return bytes;
}

function artifactBlock(
  artifactStore: ArtifactStore,
  input: ArtifactInput,
  block: Omit<StoredArtifactBlock, 'artifact'>,
): { stored: StoredArtifactBlock; input: ArtifactInput } {
  return {
    stored: {
      ...block,
      artifact: artifactStore.describe(input),
    },
    input,
  };
}

/**
 * Removes attachment bodies from the canonical transcript. The returned
 * ArtifactRefs are deterministic descriptions of the artifacts that
 * FileSessionRepository commits before appending the turn.
 */
export function prepareMessage(
  location: SessionLocation,
  message: AgentMessage,
  usage?: FsAppendMessageUsage | null,
): FsPreparedMessage {
  const artifactStore = new ArtifactStore({
    bundlePath: location.bundle_path,
    sessionId: location.session_id,
  });
  const artifacts: ArtifactInput[] = [];
  const refs: ArtifactRef[] = [];
  const content: JsonValue[] = [];

  for (let index = 0; index < message.content.length; index += 1) {
    const block = message.content[index];
    if (block.type === 'image') {
      const input: ArtifactInput = {
        kind: 'attachment',
        data: decodeBase64(block.base64, `image block ${index}`),
        media_type: block.mediaType,
        logical_name: block.name ?? `image-${index}`,
      };
      const prepared = artifactBlock(artifactStore, input, {
        type: 'artifact_ref',
        source_type: 'image',
        encoding: 'base64',
        media_type: block.mediaType,
        ...(block.name ? { name: block.name } : {}),
        ...(block.describeHint ? { describe_hint: block.describeHint } : {}),
      });
      artifacts.push(prepared.input);
      refs.push(prepared.stored.artifact);
      content.push(toJsonValue(prepared.stored));
      continue;
    }
    if (block.type === 'document' && (block.base64 != null || block.text != null)) {
      const encoding = block.base64 != null ? 'base64' : 'utf8';
      const data =
        block.base64 != null
          ? decodeBase64(block.base64, `document block ${index}`)
          : block.text!;
      const input: ArtifactInput = {
        kind: 'attachment',
        data,
        media_type: block.mediaType,
        logical_name: block.name,
      };
      const prepared = artifactBlock(artifactStore, input, {
        type: 'artifact_ref',
        source_type: 'document',
        encoding,
        media_type: block.mediaType,
        name: block.name,
        ...(block.path ? { path: block.path } : {}),
      });
      artifacts.push(prepared.input);
      refs.push(prepared.stored.artifact);
      content.push(toJsonValue(prepared.stored));
      continue;
    }
    content.push(toJsonValue(block));
  }

  return {
    stored: {
      schema_version: 1,
      role: message.role,
      ...(message.phase ? { phase: message.phase } : {}),
      content,
      usage: usageRecord(usage),
      is_meta: message.isMeta === true,
      selected_skill_ids: [...(message.selectedSkillIds ?? [])],
      artifact_refs: refs,
    },
    artifacts,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isArtifactRef(value: unknown): value is ArtifactRef {
  if (!isRecord(value)) return false;
  return (
    typeof value.artifact_id === 'string' &&
    typeof value.kind === 'string' &&
    typeof value.sha256 === 'string' &&
    typeof value.size === 'number' &&
    typeof value.relative_path === 'string'
  );
}

function isToolOutputRecord(value: unknown): value is ToolOutputRecord {
  if (!isRecord(value)) return false;
  return (
    value.schema_version === 1 &&
    isUuid(value.id) &&
    typeof value.call_id === 'string' &&
    (value.raw === null || isArtifactRef(value.raw)) &&
    (value.shaped === null || isArtifactRef(value.shaped))
  );
}

function hydrateContentBlock(
  artifactStore: ArtifactStore,
  value: JsonValue,
): ContentBlock {
  if (!isRecord(value)) {
    throw new FsConversationFormatError('Message content block is not an object');
  }
  if (value.type === 'artifact_ref') {
    const block = value as unknown as StoredArtifactBlock;
    if (!isArtifactRef(block.artifact)) {
      throw new FsConversationFormatError('Attachment block has an invalid ArtifactRef');
    }
    const bytes = artifactStore.read(block.artifact);
    if (block.source_type === 'image') {
      return {
        type: 'image',
        ...(block.name ? { name: block.name } : {}),
        mediaType: block.media_type,
        base64: Buffer.from(bytes).toString('base64'),
        ...(block.describe_hint
          ? { describeHint: block.describe_hint }
          : {}),
      };
    }
    if (block.source_type === 'document') {
      return {
        type: 'document',
        name: block.name ?? block.artifact.logical_name ?? 'attachment',
        mediaType: block.media_type,
        ...(block.path ? { path: block.path } : {}),
        ...(block.encoding === 'base64'
          ? { base64: Buffer.from(bytes).toString('base64') }
          : { text: Buffer.from(bytes).toString('utf8') }),
      };
    }
    throw new FsConversationFormatError('Unknown attachment source type');
  }
  if (value.type === 'tool_result_ref') {
    const block = value as unknown as StoredToolResultBlock;
    if (!isToolOutputRecord(block.output)) {
      throw new FsConversationFormatError('Tool result block has an invalid output record');
    }
    const selected = block.output.shaped ?? block.output.raw;
    if (!selected) {
      throw new FsConversationFormatError(
        `Tool output ${block.output.call_id} has no readable payload`,
      );
    }
    const bytes = artifactStore.read(selected);
    return {
      type: 'tool_result',
      tool_use_id: block.tool_use_id,
      content: Buffer.from(bytes).toString('utf8'),
      is_error: block.is_error,
      ...(block.effect_outcome === 'unknown' ? { effect_outcome: 'unknown' as const } : {}),
      ...(block.truncated
        ? {
            truncated: true,
            originalSize: block.original_size ?? bytes.byteLength,
          }
        : {}),
    };
  }
  return value as unknown as ContentBlock;
}

export function hydrateMessage(
  location: SessionLocation,
  stored: FsStoredMessage,
): AgentMessage {
  const artifactStore = new ArtifactStore({
    bundlePath: location.bundle_path,
    sessionId: location.session_id,
  });
  const content = stored.content;
  if (!Array.isArray(content)) {
    throw new FsConversationFormatError(`Message seq ${stored.seq} content is not an array`);
  }
  return {
    role: stored.role,
    ...(stored.phase ? { phase: stored.phase } : {}),
    content: content.map((block) => hydrateContentBlock(artifactStore, block)),
    ...(stored.is_meta ? { isMeta: true } : {}),
    ...(stored.selected_skill_ids.length > 0
      ? { selectedSkillIds: [...stored.selected_skill_ids] }
      : {}),
  };
}

function validateStoredMessage(
  message: FsStoredMessage,
  label: string,
): void {
  if (
    message.schema_version !== 1 ||
    !isUuid(message.id) ||
    !Number.isSafeInteger(message.seq) ||
    message.seq < 1 ||
    !['system', 'user', 'assistant', 'tool'].includes(message.role) ||
    (message.phase !== undefined && !['commentary', 'final_answer'].includes(message.phase)) ||
    !Array.isArray(message.content) ||
    !Array.isArray(message.selected_skill_ids) ||
    !Array.isArray(message.artifact_refs)
  ) {
    throw new FsConversationFormatError(`Invalid stored message at ${label}`);
  }
}

function validatePatch(patch: FsStoredMessagePatch, label: string): void {
  if (!Number.isSafeInteger(patch.seq) || patch.seq < 1) {
    throw new FsConversationFormatError(`Invalid message patch at ${label}`);
  }
}

export function parseCoderTurnPayload(
  commit: ConversationCommit,
): FsCoderTurnPayload {
  const payload = commit.payload as unknown as Partial<FsCoderTurnPayload>;
  if (
    payload.schema_version !== 1 ||
    payload.type !== 'coder.turn' ||
    typeof payload.request_key !== 'string' ||
    !Array.isArray(payload.messages) ||
    !Array.isArray(payload.message_patches) ||
    !Array.isArray(payload.tool_calls) ||
    !Array.isArray(payload.goal_mutations)
  ) {
    throw new FsConversationFormatError(
      `Conversation seq ${commit.seq} is not a coder.turn v1 payload`,
    );
  }
  if (
    payload.truncate_from_seq !== undefined &&
    (
      !Number.isSafeInteger(payload.truncate_from_seq) ||
      payload.truncate_from_seq < 1
    )
  ) {
    throw new FsConversationFormatError(
      `Conversation seq ${commit.seq} has an invalid rollback boundary`,
    );
  }
  return payload as FsCoderTurnPayload;
}

/** Incremental, writer-owned projection. The full reader uses the same reducer. */
export class ConversationProjection {
  private readonly messages = new Map<number, ProjectedStoredMessage>();
  private readonly messageIds = new Set<string>();
  private readonly toolCallIds = new Set<string>();
  private readonly operations = new Map<string, ConversationCommit>();
  private readonly commits: ConversationCommit[] = [];
  private toolCalls: FsToolCallRecord[] = [];
  highestMessageSeq = 0;

  findCommit(operationId: string): ConversationCommit | undefined { return this.operations.get(operationId); }
  hasMessage(seq: number, role?: string): boolean {
    const message = this.messages.get(seq);
    return !!message && (role === undefined || message.role === role);
  }

  apply(commit: ConversationCommit): void {
    const { messages, messageIds, toolCallIds } = this;
    let { toolCalls, highestMessageSeq } = this;
    const payload = parseCoderTurnPayload(commit);
    if (payload.truncate_from_seq !== undefined) {
      for (const seq of messages.keys()) {
        if (seq >= payload.truncate_from_seq) messages.delete(seq);
      }
      toolCalls = toolCalls.filter(
        (call) => call.message_seq < payload.truncate_from_seq!,
      );
    }
    for (let index = 0; index < payload.message_patches.length; index += 1) {
      const patch = payload.message_patches[index];
      validatePatch(patch, `conversation ${commit.seq}/patch ${index}`);
      const existing = messages.get(patch.seq);
      if (!existing) {
        throw new FsConversationFormatError(
          `Message patch targets missing seq ${patch.seq}`,
        );
      }
      messages.set(patch.seq, {
        ...existing,
        ...(patch.content === undefined ? {} : { content: patch.content }),
        ...(patch.usage === undefined ? {} : { usage: patch.usage }),
        ...(patch.artifact_refs === undefined
          ? {}
          : { artifact_refs: patch.artifact_refs }),
      });
    }
    for (let index = 0; index < payload.messages.length; index += 1) {
      const message = payload.messages[index];
      validateStoredMessage(message, `conversation ${commit.seq}/message ${index}`);
      if (messages.has(message.seq)) {
        throw new FsConversationFormatError(
          `Duplicate message seq ${message.seq}`,
        );
      }
      if (messageIds.has(message.id)) {
        throw new FsConversationFormatError(`Duplicate message id ${message.id}`);
      }
      if (message.seq <= highestMessageSeq) {
        throw new FsConversationFormatError(
          `Message seq ${message.seq} is not append-only`,
        );
      }
      highestMessageSeq = message.seq;
      messageIds.add(message.id);
      messages.set(message.seq, {
        ...message,
        turn_seq: commit.seq,
        operation_id: commit.operation_id,
        committed_at: commit.committed_at,
      });
    }
    for (const call of payload.tool_calls) {
      if (
        call.schema_version !== 1 ||
        !isUuid(call.id) ||
        !Number.isSafeInteger(call.message_seq) ||
        call.message_seq < 1 ||
        typeof call.tool_use_id !== 'string' ||
        typeof call.tool_name !== 'string' ||
        !isToolOutputRecord(call.output)
      ) {
        throw new FsConversationFormatError(
          `Invalid tool call in conversation seq ${commit.seq}`,
        );
      }
      if (toolCallIds.has(call.id)) {
        throw new FsConversationFormatError(`Duplicate tool call id ${call.id}`);
      }
      toolCallIds.add(call.id);
      toolCalls.push(call);
    }
    this.toolCalls = toolCalls;
    this.highestMessageSeq = highestMessageSeq;
    this.operations.set(commit.operation_id, commit);
    this.commits.push(commit);
  }

  snapshot(): FsConversationProjection {
    return {
      storedMessages: [...this.messages.values()].sort((left, right) => left.seq - right.seq),
      toolCalls: [...this.toolCalls],
      commits: [...this.commits],
      highestMessageSeq: this.highestMessageSeq,
    };
  }
}

export function projectConversation(commits: readonly ConversationCommit[]): FsConversationProjection {
  const projection = new ConversationProjection();
  for (const commit of commits) projection.apply(commit);
  return projection.snapshot();
}

export { messageRow } from './conversation-message-row.js';

export function requestKey(value: unknown): string {
  return computeRequestHash(toJsonValue(value));
}

export function extractText(message: AgentMessage): string | null {
  const text = message.content
    .filter(
      (block): block is Extract<ContentBlock, { type: 'text' }> =>
        block.type === 'text',
    )
    .map((block) => block.text)
    .join('\n')
    .trim();
  return text || null;
}
