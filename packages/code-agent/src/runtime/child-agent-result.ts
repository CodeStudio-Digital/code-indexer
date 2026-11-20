/**
 * The text a parent receives for child-agent results. The E6 tools return it
 * as their tool result (create_chat with a wait, wait_chats, read_chat), and a
 * background child's completion notice carries it in the parent's mailbox.
 *
 * One shape for both: a header line per child, its changed files, a question
 * when it asked one, then its final answer. A wait result is bounded by the
 * subagent tool result cap: waitForChildAgents, given the parent's spill,
 * keeps the head of a longer answer and stores the whole one, and the text
 * points at it (get_tool_output), as spawn_agent does. A notice is bounded to
 * CHILD_AGENT_NOTICE_TEXT_MAX, since a mailbox message is capped, and points
 * at read_chat for the rest.
 */
import type { ChildAgentWaitItem, ChildAgentWaitResult } from './child-agent-wait.js';

/** Answer characters a completion notice carries (the mailbox caps a message at 32000). */
export const CHILD_AGENT_NOTICE_TEXT_MAX = 8_000;

const MAX_LISTED_FILES = 50;

function header(item: ChildAgentWaitItem): string {
  const reason = item.reason && item.reason !== item.status ? ` (${item.reason})` : '';
  return `Chat ${item.chatId}: ${item.status}${reason}`;
}

function files(item: ChildAgentWaitItem): string[] {
  const changed = item.changedFiles ?? [];
  if (changed.length === 0) return [];
  const listed = changed.slice(0, MAX_LISTED_FILES).join(', ');
  const more = changed.length > MAX_LISTED_FILES ? ` and ${changed.length - MAX_LISTED_FILES} more` : '';
  return [`Changed files: ${listed}${more}`];
}

function body(item: ChildAgentWaitItem, textMax: number | null): string[] {
  const lines: string[] = [];
  if (item.question) lines.push(`Question (request ${item.question.requestId}): ${item.question.text}`);
  const text = item.finalText?.trim();
  if (!text) return lines;
  const cut = textMax != null && text.length > textMax;
  lines.push('Answer:', cut ? text.slice(0, textMax) : text);
  if (item.outputId) lines.push(`[Answer truncated; the full answer is tool output ${item.outputId}, read it with get_tool_output.]`);
  else if (cut) lines.push(`[Answer truncated at ${textMax} of ${text.length} characters; read the full answer with read_chat ${item.chatId}.]`);
  return lines;
}

/** One child's result, as a tool returns it (already bounded by the wait's spill). */
export function formatChildAgentItem(item: ChildAgentWaitItem): string {
  return [header(item), ...files(item), ...body(item, null)].join('\n');
}

/** A wait's result: its outcome, then every child it was about. */
export function formatChildAgentWait(result: ChildAgentWaitResult): string {
  const outcome = result.outcome === 'ready' ? 'Wait ended.'
    : result.outcome === 'timeout' ? 'Wait timed out; the children below keep running unless stopped.'
      : 'Wait aborted.';
  return [outcome, ...result.items.map(formatChildAgentItem)].join('\n\n');
}

/** The body of a background child's completion notice, bounded for the mailbox. */
export function formatChildAgentNotice(item: ChildAgentWaitItem): string {
  const opening = item.status === 'aborted' && item.reason?.startsWith('stopped')
    ? 'A child agent you started without waiting was stopped by the user.'
    : 'A child agent you started without waiting has finished.';
  return [opening, header(item), ...files(item),
    ...body(item, CHILD_AGENT_NOTICE_TEXT_MAX)].join('\n');
}
