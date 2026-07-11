import { describe, expect, it } from 'vitest';
import type { CoderMessageRow } from '@mcp/code-agent/sessions/types.js';
import { chunkArchivedConversation } from '../chapter-rebuild.js';

function row(id: number, role: CoderMessageRow['role'], chars = 20): CoderMessageRow {
  return {
    id,
    session_id: 1,
    role,
    content_json: JSON.stringify([{ type: 'text', text: 'x'.repeat(chars) }]),
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    created_at: '2026-07-10 10:00:00',
  };
}

describe('historical chapter rebuild chunking', () => {
  it('caps chunks and starts every split at a user boundary', () => {
    const rows: CoderMessageRow[] = [];
    for (let turn = 0; turn < 24; turn++) {
      rows.push(row(rows.length + 1, 'user'));
      rows.push(row(rows.length + 1, 'assistant'));
      rows.push(row(rows.length + 1, 'tool'));
    }
    const chunks = chunkArchivedConversation(rows);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.rows.length <= 50)).toBe(true);
    expect(chunks.every((chunk) => chunk.chars <= 60_000)).toBe(true);
    expect(chunks.every((chunk) => chunk.rows[0]?.role === 'user')).toBe(true);
    expect(chunks.flatMap((chunk) => chunk.rows).map((item) => item.id))
      .toEqual(rows.map((item) => item.id));
  });

  it('rejects a single user turn that cannot satisfy both hard caps', () => {
    expect(() => chunkArchivedConversation([row(1, 'user', 61_000)]))
      .toThrow(/exceeds the rebuild chunk limit/);
  });
});
