import type { FsSessionWithMessages } from '@mcp/session-storage/fs-store/index.js';

/** This is only the HTTP shape guard. The native admission still verifies the
 * authoritative frontier and rejects unresolved effects before any execution. */
export function hasResumableNativeToolAttachments(data: FsSessionWithMessages): boolean {
  const { messages, message_rows: rows, session } = data;
  if (!rows || rows.length !== messages.length || messages.at(-1)?.role !== 'user') return false;
  const attachments: string[] = [];
  let index = messages.length - 1;
  while (index >= 0 && messages[index]?.role === 'user') {
    const row = rows[index]!;
    if (!row.id.startsWith(`${session.id}:native:`) || row.session_id !== session.id
      || row.role !== 'user' || !row.operation_id?.endsWith(':attachments')) return false;
    attachments.push(row.operation_id.slice(0, -':attachments'.length));
    index--;
  }
  const tools = new Set<string>();
  while (index >= 0 && messages[index]?.role === 'tool') {
    for (const block of messages[index]!.content) {
      if (block.type === 'tool_result' && rows[index]?.operation_id === block.tool_use_id) tools.add(block.tool_use_id);
    }
    index--;
  }
  return attachments.length > 0 && attachments.every(id => tools.has(id));
}
