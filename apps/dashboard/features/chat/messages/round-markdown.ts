export type ReadMarkdown = (signal: AbortSignal) => string | Promise<string>;

/** Only a partially loaded round needs I/O. The cursor is exclusive on both
 * sides so loading earlier text cannot include the previous user's reply. */
export async function prependRoundMarkdown(
  sessionId: string, userSeq: number, beforeSeq: number, loaded: string, signal: AbortSignal,
): Promise<string> {
  const parts: string[] = [loaded];
  let cursor = beforeSeq;
  while (cursor > userSeq + 1) {
    const query = new URLSearchParams({ before_seq: String(cursor), limit: String(Math.min(100, cursor - userSeq - 1)),
      detail: 'assistant-text', include_archived: '1' });
    const response = await fetch(`/api/coder/sessions/${encodeURIComponent(sessionId)}/messages?${query}`, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const page: { items: { seq: number; text: string }[]; next_before_seq: number | null } = await response.json();
    const text = page.items.filter(item => item.seq > userSeq && item.seq < cursor && item.text)
      .map(item => item.text).join('\n\n');
    if (text) parts.push(text);
    if (page.next_before_seq == null) break;
    if (page.next_before_seq >= cursor) throw new Error('Invalid message page cursor');
    cursor = page.next_before_seq;
  }
  return parts.reverse().filter(Boolean).join('\n\n');
}
