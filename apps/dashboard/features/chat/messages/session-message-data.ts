import type {
  AgentAttachment,
  ContentBlock,
  MessagePage,
  SessionId,
  SessionData,
  ToolResultFallback,
} from '../types.js';

let optimisticMessageSequence = 0;

/** Allocate a client-only negative sequence that cannot collide with persisted rows. */
export function allocateOptimisticMessageId(): number {
  optimisticMessageSequence = (optimisticMessageSequence + 1) % 1000;
  return -(Date.now() * 1000 + optimisticMessageSequence);
}

function optimisticContent(text: string, attachments: readonly AgentAttachment[]): ContentBlock[] {
  const content: ContentBlock[] = [{ type: 'text', text }];
  for (const attachment of attachments) {
    if (attachment.mediaType.startsWith('image/') && attachment.base64) {
      content.push({
        type: 'image',
        mediaType: attachment.mediaType,
        base64: attachment.base64,
      });
      continue;
    }
    content.push({
      type: 'document',
      name: attachment.name || 'attachment',
      mediaType: attachment.mediaType,
      path: attachment.path,
      text: attachment.text,
      base64: attachment.base64,
    });
  }
  return content;
}

/**
 * Show a submitted user turn immediately, before preflight or the first model
 * cycle completes. A later session refetch replaces this client-only row with
 * the authoritative database row.
 */
export function appendOptimisticUserMessage(
  previous: SessionData,
  input: {
    sessionId: SessionId;
    messageId: number;
    text: string;
    attachments?: readonly AgentAttachment[];
    selectedSkillIds?: readonly string[];
  },
): SessionData {
  if (previous.session.id !== input.sessionId) return previous;
  if (previous.message_rows.some((row) => row.seq === input.messageId)) return previous;

  return {
    ...previous,
    messages: [
      ...previous.messages,
      {
        role: 'user',
        content: optimisticContent(input.text, input.attachments ?? []),
        ...(input.selectedSkillIds?.length
          ? { selectedSkillIds: [...input.selectedSkillIds] }
          : {}),
      },
    ],
    message_rows: [
      ...previous.message_rows,
      {
        id: `optimistic:${Math.abs(input.messageId)}`,
        seq: input.messageId,
        input_tokens: 0,
        output_tokens: 0,
        optimistic: true,
      },
    ],
    total_messages: (previous.total_messages ?? previous.message_rows.length) + 1,
  };
}

function dedupeToolResults(
  earlier: ToolResultFallback[] = [],
  current: ToolResultFallback[] = [],
): ToolResultFallback[] | undefined {
  if (earlier.length === 0 && current.length === 0) return undefined;
  const byToolUseId = new Map<string, ToolResultFallback>();
  for (const result of earlier) byToolUseId.set(result.tool_use_id, result);
  // The already-loaded value is newer and wins when an overlapping page
  // carries the same fallback entry.
  for (const result of current) byToolUseId.set(result.tool_use_id, result);
  return [...byToolUseId.values()];
}

/**
 * Keep the API's parallel message/message-row arrays aligned while removing
 * repeated database rows that may already exist in the client cache.
 */
export function normalizeSessionMessageData(data: SessionData): SessionData {
  if (data.messages.length !== data.message_rows.length) return data;

  const seen = new Set<string>();
  const pairs: Array<{
    message: SessionData['messages'][number];
    row: SessionData['message_rows'][number];
    insertion: number;
  }> = [];
  for (let index = 0; index < data.message_rows.length; index++) {
    const row = data.message_rows[index];
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    pairs.push({ message: data.messages[index], row, insertion: index });
  }

  // Persisted rows use the monotonic conversation sequence. Client-only
  // negative optimistic rows always remain at the live tail until a refetch
  // replaces them with their authoritative database record.
  pairs.sort((left, right) => {
    const leftOptimistic = left.row.optimistic || left.row.seq < 0;
    const rightOptimistic = right.row.optimistic || right.row.seq < 0;
    if (leftOptimistic !== rightOptimistic) return leftOptimistic ? 1 : -1;
    if (leftOptimistic) return left.insertion - right.insertion;
    return left.row.seq - right.row.seq || left.insertion - right.insertion;
  });
  const messages = pairs.map((pair) => pair.message);
  const messageRows = pairs.map((pair) => pair.row);

  const toolResults = dedupeToolResults([], data.tool_results);
  const rowsChanged = messageRows.length !== data.message_rows.length
    || messageRows.some((row, index) => row !== data.message_rows[index]);
  const toolResultsChanged = (toolResults?.length ?? 0) !== (data.tool_results?.length ?? 0);
  if (!rowsChanged && !toolResultsChanged) return data;
  return {
    ...data,
    messages,
    message_rows: messageRows,
    tool_results: toolResults,
  };
}

/** Never render/cache a retained useApi payload under a different selection. */
export function sessionDataForSelection(
  data: SessionData | null,
  selectedSessionId: SessionId | null,
): SessionData | null {
  if (!data || data.session.id !== selectedSessionId) return null;
  return normalizeSessionMessageData(data);
}

/**
 * Merge any history page into the session that requested it. Pages may come
 * from sequential pagination or direct chapter anchors and can therefore
 * arrive in any order. Existing rows remain authoritative; the canonical
 * transcript is sorted by the monotonic message sequence.
 */
export function mergeEarlierMessagePage(
  previous: SessionData,
  page: MessagePage,
  expectedSessionId: SessionId,
): { data: SessionData; addedRows: number } {
  if (previous.session.id !== expectedSessionId) {
    return { data: previous, addedRows: 0 };
  }
  if (page.messages.length !== page.message_rows.length) {
    return { data: previous, addedRows: 0 };
  }

  const current = normalizeSessionMessageData(previous);
  const seen = new Set(current.message_rows.map((row) => row.id));
  const incomingMessages: SessionData['messages'] = [];
  const incomingRows: SessionData['message_rows'] = [];
  for (let index = 0; index < page.message_rows.length; index++) {
    const row = page.message_rows[index];
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    incomingMessages.push(page.messages[index]);
    incomingRows.push(row);
  }

  const toolResults = dedupeToolResults(page.tool_results, current.tool_results);
  if (incomingRows.length === 0) {
    return { data: current, addedRows: 0 };
  }
  const currentEarliest = current.message_rows
    .filter((row) => !row.optimistic && row.seq > 0)
    .reduce((earliest, row) => Math.min(earliest, row.seq), Number.POSITIVE_INFINITY);
  const incomingEarliest = incomingRows
    .filter((row) => !row.optimistic && row.seq > 0)
    .reduce((earliest, row) => Math.min(earliest, row.seq), Number.POSITIVE_INFINITY);
  const merged = normalizeSessionMessageData({
    ...current,
    messages: [...current.messages, ...incomingMessages],
    message_rows: [...current.message_rows, ...incomingRows],
    preceding_user_seq: incomingEarliest < currentEarliest
      ? page.preceding_user_seq
      : current.preceding_user_seq,
    tool_results: toolResults,
  });
  return {
    data: merged,
    addedRows: incomingRows.length,
  };
}
