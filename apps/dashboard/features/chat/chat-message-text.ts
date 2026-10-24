import type { PersistedMessage } from './types.js';
import type { AssistantTurn, StreamBlock } from '../../hooks/useAgentStream.js';
import { isToolImagePlumbing } from './chat-message-grouping.js';

export function getPersistedAssistantText(message: PersistedMessage): string {
  if (message.role !== 'assistant') return '';
  return message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n');
}

export function getCurrentTurnText(turn: AssistantTurn | null): string {
  if (!turn) return '';
  return turn.blocks
    .filter((b): b is StreamBlock & { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

export function getPersistedAssistantThinkingText(message: PersistedMessage): string {
  if (message.role !== 'assistant') return '';
  return message.content
    .filter((b) => (b as { type?: string }).type === 'thinking')
    .map((b) => (b as { text?: string }).text ?? '')
    .join('\n');
}

export function getCurrentTurnThinkingText(turn: AssistantTurn | null): string {
  if (!turn) return '';
  return turn.blocks
    .filter((b): b is StreamBlock & { type: 'thinking'; text: string } => b.type === 'thinking')
    .map((b) => b.text)
    .join('\n');
}

// ─── Live ⇄ persisted block dedup ───────────────────────────────
//
// A gate tool (submit_tasks / submit_plan / decision_gate / ask_user /
// submit_spec) PAUSES the turn awaiting approval, so `message_complete` never
// fires to clear the live buffer. Meanwhile the assistant message is
// checkpoint-persisted and, on reattach/reopen, the re-opened SSE re-emits the
// same gate as a LIVE block while the refetched history already renders the
// PERSISTED card → the user sees the card twice. The text-only
// `liveTurnDuplicatedInHistory` guard can't catch this (gate turns carry no
// text). We dedup at the block level: if a live block's tool_use id already
// exists in persisted history, the persisted card is canonical and the live
// copy is suppressed. We also detect a whole current turn that is already fully
// represented by persisted history (text/thinking plus any persisted tool ids),
// so the live buffer can be hidden/cleared instead of duplicating the final turn.

/** The persisted tool_use id a live block corresponds to, if any. */
export function liveBlockPersistedId(b: StreamBlock): string | undefined {
  switch (b.type) {
    case 'tasks':
      return b.tasks.tool_use_id;
    case 'plan':
      return b.plan.id;
    case 'spec':
      return b.spec.id;
    case 'question':
      return b.question.id;
    case 'decision':
      return b.decision.id;
    case 'tool':
      return b.call.id;
    case 'agents':
      return b.group.toolUseId;
    default:
      return undefined;
  }
}

/**
 * Cheap structural revision for reconciliation work.
 *
 * Token deltas mutate the current text/thinking block in place, so rescanning
 * the complete accumulated run on every frame is unnecessary. Durable-history
 * changes still invalidate via their own reconciliation index; this revision
 * changes when a block is added/replaced or an identity-bearing tail resolves.
 */
export function liveTurnReconciliationRevision(
  turn: AssistantTurn | null,
  tailTextLength = 0,
  tailThinkingLength = 0,
): string {
  const blocks = turn?.blocks ?? [];
  const last = blocks[blocks.length - 1];
  if (!last) return '0';
  const identity = liveBlockPersistedId(last) ?? last.type;
  const status = last.type === 'tool'
    ? last.call.status
    : last.type === 'agents' ? last.group.status : '';
  // A text-only replay adds no structural block after its final delta. Flip
  // exactly once when that tail can cover the latest durable message, without
  // invalidating on every intermediate token.
  const tailReady = last.type === 'text' && tailTextLength > 0
    ? (last.text.length >= tailTextLength ? 'text-ready' : 'text-streaming')
    : last.type === 'thinking' && tailThinkingLength > 0
      ? (last.text.length >= tailThinkingLength ? 'thinking-ready' : 'thinking-streaming')
      : '';
  // The digest only inspects the LAST block, so a status flip on an earlier one
  // (a task_run finishing above newer text) would not rebuild the projection.
  // `rev` is bumped by the projector for any structural event, which covers that
  // without scanning a multi-KB buffer on every frame.
  return `${blocks.length}:${last.type}:${identity}:${status}:${tailReady}:${turn?.rev ?? ''}`;
}

/** All assistant tool_use ids already persisted to history. */
export function collectPersistedToolUseIds(messages: PersistedMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const b of m.content) {
      if (b.type === 'tool_use' && b.id) ids.add(b.id);
    }
  }
  return ids;
}

/** All tool_result ids already persisted to history. */
export function collectPersistedToolResultIds(messages: PersistedMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'tool') continue;
    for (const b of m.content) {
      if (b.type === 'tool_result' && b.tool_use_id) ids.add(b.tool_use_id);
    }
  }
  return ids;
}

export function latestVisibleUserIndex(messages: PersistedMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === 'user' && !message.isMeta && !isToolImagePlumbing(message)) return index;
  }
  return -1;
}
