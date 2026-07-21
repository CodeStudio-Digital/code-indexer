import type { MessagePage, SessionData, ToolResultFallback } from '../types.js';

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

  const seen = new Set<number>();
  const messages: SessionData['messages'] = [];
  const messageRows: SessionData['message_rows'] = [];
  for (let index = 0; index < data.message_rows.length; index++) {
    const row = data.message_rows[index];
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    messages.push(data.messages[index]);
    messageRows.push(row);
  }

  const toolResults = dedupeToolResults([], data.tool_results);
  const rowsChanged = messageRows.length !== data.message_rows.length;
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
  selectedSessionId: number | null,
): SessionData | null {
  if (!data || data.session.id !== selectedSessionId) return null;
  return normalizeSessionMessageData(data);
}

/**
 * Prepend an earlier page only to the session that requested it. Overlapping
 * pages are harmless: existing message ids remain authoritative and every
 * message stays paired with the MessageRow at the same index.
 */
export function mergeEarlierMessagePage(
  previous: SessionData,
  page: MessagePage,
  expectedSessionId: number,
): { data: SessionData; addedRows: number } {
  if (previous.session.id !== expectedSessionId) {
    return { data: previous, addedRows: 0 };
  }
  if (page.messages.length !== page.message_rows.length) {
    return { data: previous, addedRows: 0 };
  }

  const current = normalizeSessionMessageData(previous);
  const seen = new Set(current.message_rows.map((row) => row.id));
  const earlierMessages: SessionData['messages'] = [];
  const earlierRows: SessionData['message_rows'] = [];
  for (let index = 0; index < page.message_rows.length; index++) {
    const row = page.message_rows[index];
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    earlierMessages.push(page.messages[index]);
    earlierRows.push(row);
  }

  const toolResults = dedupeToolResults(page.tool_results, current.tool_results);
  if (earlierRows.length === 0) {
    return { data: current, addedRows: 0 };
  }
  return {
    data: {
      ...current,
      messages: [...earlierMessages, ...current.messages],
      message_rows: [...earlierRows, ...current.message_rows],
      preceding_user_message_id: page.preceding_user_message_id,
      tool_results: toolResults,
    },
    addedRows: earlierRows.length,
  };
}
