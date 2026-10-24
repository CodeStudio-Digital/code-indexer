import type { AgentMessage } from '@mcp/provider-sdk';
import type { FsCoderMessageRow, FsCoderSession, FsConversationRuntimeOutcome } from './types.js';
import type { FsSessionGoal } from './operational-types.js';

export type FsConversationProjectionQuery =
  | { kind: 'visible' | 'stats'; boundary: number }
  | { kind: 'tail'; boundary: number; limit: number }
  | { kind: 'before'; boundary: number; beforeSeq: number; limit: number; includeArchived?: boolean }
  | { kind: 'range'; startSeq: number; endSeq: number; afterSeq: number; limit: number }
  | { kind: 'after'; afterSeq: number }
  | { kind: 'message'; seq: number }
  | { kind: 'firstUser' | 'latestUser' }
  | { kind: 'previousUser'; beforeSeq: number };

export interface FsConversationProjection {
  messages: AgentMessage[];
  rows: FsCoderMessageRow[];
  runtime_outcome?: FsConversationRuntimeOutcome;
  nativeGoal?: FsSessionGoal;
  nativeTasks?: import('../session-state-types.js').TasksState | null;
  usage?: Pick<FsCoderSession, 'total_input_tokens' | 'total_output_tokens' | 'total_cache_read_tokens'
    | 'total_cache_creation_tokens' | 'last_turn_input_tokens'>;
  selection?: {
    kind: FsConversationProjectionQuery['kind'];
    nextCursor: number | null;
    maxSeq: number;
    visibleCount: number;
    archivedCount: number;
  };
}

/** First row at or after seq. Projections are already validated and ordered. */
function lowerBound(rows: readonly FsCoderMessageRow[], seq: number): number {
  let low = 0; let high = rows.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (rows[middle]!.seq < seq) low = middle + 1; else high = middle;
  }
  return low;
}

/** Resolve a window before worker transport; counting never visits message contents. */
export function queryConversationProjection(source: FsConversationProjection,
  query: FsConversationProjectionQuery): FsConversationProjection {
  const { rows } = source;
  const boundary = 'boundary' in query ? query.boundary : 0;
  const archivedCount = lowerBound(rows, boundary + 1);
  let start = archivedCount; let end = rows.length; let nextCursor: number | null = null;
  switch (query.kind) {
    case 'stats': start = end; break;
    case 'visible': break;
    case 'tail':
    case 'before': {
      if (query.kind === 'before') end = Math.max(start, lowerBound(rows, query.beforeSeq));
      const first = start;
      let remaining = Math.max(1, query.limit);
      for (let index = end - 1; index >= first; index--) {
        if (rows[index]!.role !== 'tool') { start = index; if (--remaining === 0) break; }
      }
      if (query.kind === 'tail') end = Math.min(end, start + Math.max(1, query.limit) * 5);
      else if (start > first && start < end) nextCursor = rows[start]!.seq;
      break;
    }
    case 'range':
      start = lowerBound(rows, Math.max(query.startSeq, query.afterSeq + 1));
      end = Math.max(start, lowerBound(rows, query.endSeq + 1));
      if (end > start + Math.max(1, query.limit)) {
        end = start + Math.max(1, query.limit); nextCursor = rows[end - 1]!.seq;
      }
      break;
    case 'after': start = lowerBound(rows, query.afterSeq + 1); break;
    case 'message':
      start = lowerBound(rows, query.seq); end = start + (rows[start]?.seq === query.seq ? 1 : 0); break;
    case 'firstUser': {
      const index = rows.findIndex(row => row.role === 'user');
      start = index < 0 ? rows.length : index; end = Math.min(rows.length, start + 1); break;
    }
    case 'latestUser':
    case 'previousUser': {
      let index = query.kind === 'previousUser' ? lowerBound(rows, query.beforeSeq) - 1 : rows.length - 1;
      while (index >= 0 && (rows[index]!.role !== 'user' || rows[index]!.is_meta !== 0)) index--;
      start = index < 0 ? rows.length : index; end = Math.min(rows.length, start + 1); break;
    }
  }
  return { messages: source.messages.slice(start, end), rows: rows.slice(start, end), usage: source.usage,
    runtime_outcome: source.runtime_outcome, nativeGoal: source.nativeGoal, nativeTasks: source.nativeTasks,
    selection: { kind: query.kind, nextCursor, maxSeq: rows.at(-1)?.seq ?? 0,
      visibleCount: rows.length - archivedCount, archivedCount } };
}
