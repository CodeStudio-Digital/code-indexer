import type { AgentMessage, ContentBlock } from '@mcp/provider-sdk';
import type { FsCoderMessageRow } from './types.js';
import type { ProjectedStoredMessage } from './conversation-codec.js';

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

export function messageRow(
  sessionId: FsCoderMessageRow['session_id'],
  stored: ProjectedStoredMessage,
  hydrated: AgentMessage,
): FsCoderMessageRow {
  return {
    id: stored.id,
    seq: stored.seq,
    session_id: sessionId,
    turn_seq: stored.turn_seq,
    operation_id: stored.operation_id,
    role: stored.role,
    phase: hydrated.phase ?? null,
    content_json: JSON.stringify(hydrated.content),
    input_tokens: stored.usage.input_tokens,
    output_tokens: stored.usage.output_tokens,
    cache_read_tokens: stored.usage.cache_read_tokens,
    cache_creation_tokens: stored.usage.cache_creation_tokens,
    created_at: stored.committed_at,
    is_meta: stored.is_meta ? 1 : 0,
    selected_skill_ids_json:
      stored.selected_skill_ids.length > 0
        ? JSON.stringify(stored.selected_skill_ids)
        : null,
    artifact_refs: stored.artifact_refs,
  };
}

