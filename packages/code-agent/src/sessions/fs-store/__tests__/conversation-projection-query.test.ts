import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import { queryConversationProjection, type FsConversationProjection } from '../conversation-projection-query.js';
import type { FsCoderMessageRow } from '../types.js';

function projection(roles: AgentMessage['role'][]): FsConversationProjection {
  const messages = roles.map((role, index) => ({ role, content: [{ type: 'text' as const, text: `message ${index + 1}` }] }));
  const rows = roles.map((role, index) => ({ seq: index + 1, role, is_meta: 0,
    content_json: JSON.stringify(messages[index]!.content) }) as FsCoderMessageRow);
  return { messages, rows };
}

describe('querying an authoritative conversation projection', () => {
  it('preserves pagination, archive and tool-row semantics including leading tool rows', () => {
    const source = projection(['tool', 'user', 'assistant', 'tool', 'tool', 'user', 'assistant', 'tool', 'assistant']);
    const rows = (kind: 'tail' | 'before', boundary: number, limit: number, beforeSeq = 10) =>
      queryConversationProjection(source, { kind, boundary, limit, beforeSeq });
    expect(rows('tail', 0, 2).rows.map(row => row.seq)).toEqual([7, 8, 9]);
    expect(rows('tail', 0, 20).rows.map(row => row.seq)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    const page = rows('before', 0, 2, 7);
    expect(page.rows.map(row => row.seq)).toEqual([3, 4, 5, 6]);
    expect(page.selection!.nextCursor).toBe(3);
    expect(rows('before', 4, 2, 5).rows).toEqual([]);
    expect(rows('before', 0, 20).selection!.nextCursor).toBe(2);
    const stats = queryConversationProjection(source, { kind: 'stats', boundary: 5 });
    expect(stats.rows).toEqual([]);
    expect(stats.messages).toEqual([]);
    expect(stats.selection).toMatchObject({ archivedCount: 5, visibleCount: 4, maxSeq: 9 });
    expect(queryConversationProjection(source, { kind: 'visible', boundary: 5 }).rows.map(row => row.seq)).toEqual([6, 7, 8, 9]);
  });

  it('matches the previous paging contract across mixed sparse sequences', () => {
    const source = projection(Array.from({ length: 80 }, (_, index) => (['tool', 'user', 'assistant', 'tool', 'tool'] as const)[index % 5]!));
    source.rows.forEach(row => { row.seq *= 3; });
    for (const boundary of [0, 1, 90, 239, 300]) for (const beforeSeq of [0, 100, 241]) for (const limit of [1, 2, 20, 200]) {
      const candidates = source.rows.filter(row => row.seq > boundary && row.seq < beforeSeq);
      const renderable = candidates.filter(row => row.role !== 'tool');
      const cutoff = renderable[Math.max(0, renderable.length - Math.max(1, limit))]?.seq ?? 0;
      const selected = candidates.filter(row => row.seq >= cutoff);
      const page = queryConversationProjection(source, { kind: 'before', boundary, beforeSeq, limit });
      expect(page.rows).toEqual(selected);
      expect(page.selection!.nextCursor).toBe(selected.length && candidates[0]!.seq < selected[0]!.seq ? selected[0]!.seq : null);
    }
  });

  it('selects single messages, substantive user inputs and bounded chapter ranges', () => {
    const source = projection(['user', 'assistant', 'user', 'assistant', 'user']);
    source.rows[4]!.is_meta = 1;
    source.messages[4]!.isMeta = true;
    expect(queryConversationProjection(source, { kind: 'message', seq: 99 }).rows).toEqual([]);
    expect(queryConversationProjection(source, { kind: 'message', seq: 2 }).rows[0]!.seq).toBe(2);
    expect(queryConversationProjection(source, { kind: 'firstUser' }).rows[0]!.seq).toBe(1);
    expect(queryConversationProjection(source, { kind: 'latestUser' }).rows[0]!.seq).toBe(3);
    expect(queryConversationProjection(source, { kind: 'previousUser', beforeSeq: 3 }).rows[0]!.seq).toBe(1);
    const range = queryConversationProjection(source, { kind: 'range', startSeq: 2, endSeq: 5, afterSeq: 2, limit: 2 });
    expect(range.rows.map(row => row.seq)).toEqual([3, 4]);
    expect(range.selection!.nextCursor).toBe(4);
    expect(queryConversationProjection(source, { kind: 'after', afterSeq: 4 }).rows.map(row => row.seq)).toEqual([5]);
  });

  it.each([100, 1_000, 10_000])('reads only the requested window across %i turns', turns => {
    const source = projection(Array.from({ length: turns * 4 }, (_, index) => (['user', 'assistant', 'tool', 'assistant'] as const)[index % 4]!));
    let rowReads = 0; let messageReads = 0;
    source.rows = new Proxy(source.rows, { get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) rowReads++;
      return Reflect.get(target, property, receiver);
    } });
    source.messages = new Proxy(source.messages, { get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) messageReads++;
      return Reflect.get(target, property, receiver);
    } });
    const count = queryConversationProjection(source, { kind: 'stats', boundary: turns * 2 });
    expect(count.selection!.visibleCount).toBe(turns * 2);
    expect(rowReads).toBeLessThan(25);
    expect(messageReads).toBe(0);
    rowReads = 0;
    const page = queryConversationProjection(source, { kind: 'tail', limit: 10, boundary: 0 });
    expect(page.messages.length).toBeLessThanOrEqual(14);
    expect(messageReads).toBe(page.messages.length);
    expect(rowReads).toBeLessThan(60);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(4_000);
  });
});
