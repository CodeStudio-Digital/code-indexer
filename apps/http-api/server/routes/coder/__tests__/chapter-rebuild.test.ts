import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { asSessionId } from '@mcp/session-storage';
import type { FsCoderMessageRow } from '@mcp/session-storage/fs-store/index.js';
import { chunkArchivedConversation } from '../chapter-rebuild.js';

const sessionId = asSessionId(randomUUID());

function row(
  seq: number,
  role: FsCoderMessageRow['role'],
  chars = 20,
): FsCoderMessageRow {
  return {
    id: randomUUID(),
    seq,
    turn_seq: seq,
    operation_id: randomUUID(),
    session_id: sessionId,
    role,
    content_json: JSON.stringify([{ type: 'text', text: 'x'.repeat(chars) }]),
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    created_at: '2026-07-10 10:00:00',
    is_meta: 0,
    selected_skill_ids_json: null,
    artifact_refs: [],
  };
}

describe('historical chapter rebuild chunking', () => {
  it('caps chunks without losing rows from a giant autonomous turn', () => {
    const rows: FsCoderMessageRow[] = [];
    for (let turn = 0; turn < 24; turn++) {
      rows.push(row(rows.length + 1, 'user'));
      rows.push(row(rows.length + 1, 'assistant'));
      rows.push(row(rows.length + 1, 'tool'));
    }
    const chunks = chunkArchivedConversation(rows);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.rows.length <= 50)).toBe(true);
    expect(chunks.every((chunk) => chunk.chars <= 60_000)).toBe(true);
    expect(chunks.flatMap((chunk) => chunk.rows).map((item) => item.seq))
      .toEqual(rows.map((item) => item.seq));
  });

  it('accepts one oversized atomic message as its own sampled chunk', () => {
    const chunks = chunkArchivedConversation([row(1, 'user', 61_000)]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.rows.map((item) => item.seq)).toEqual([1]);
  });

  it('never separates tool_use from its following tool_result', () => {
    const assistant = row(2, 'assistant', 20);
    assistant.content_json = JSON.stringify([{
      type: 'tool_use', id: 'tool-1', name: 'run', input: {},
    }]);
    const rows = [row(1, 'user', 59_900), assistant, row(3, 'tool', 1_000), row(4, 'assistant')];
    const chunks = chunkArchivedConversation(rows);
    const toolUseChunk = chunks.find((chunk) => chunk.rows.some((item) => item.seq === 2));
    expect(toolUseChunk?.rows.some((item) => item.seq === 3)).toBe(true);
  });
});
