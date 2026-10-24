import type { PersistedMessage } from './types.js';
import { normalizeRunText, normalizedCovers, persistedCoveragePrefixEnd } from './live-run-alignment.js';
import type { AssistantTurn, StreamBlock } from '../../hooks/useAgentStream.js';
import { latestVisibleUserIndex, getPersistedAssistantText, getPersistedAssistantThinkingText, getCurrentTurnText, getCurrentTurnThinkingText, liveBlockPersistedId } from './chat-message-text.js';
import { collectLatestPersistedInteractivePromptSignatures, liveBlockPersistedSignature, persistedInteractivePromptSignature } from './chat-prompt-signatures.js';

/**
 * Immutable history-side index used by live/persisted reconciliation.
 *
 * Building this once per history refetch avoids rescanning every persisted
 * message and rebuilding large joined strings on each token frame. The live
 * side can still change every frame, but the usually much larger durable side
 * remains O(1) to reuse.
 */
export interface PersistedLiveReconciliation {
  assistantRun: PersistedMessage[];
  /** The loaded window begins after its owning user message. */
  startsMidTurn: boolean;
  precedingUserMessageId: number | null;
  persistedText: string;
  persistedThinking: string;
  /** Whitespace-stripped companions — see `live-run-alignment.ts` for why every
   *  live⇄persisted comparison runs on these instead of the raw strings. */
  persistedTextNormalized: string;
  persistedThinkingNormalized: string;
  /** Raw sizes of the newest durable assistant row for one-shot replay readiness. */
  tailTextLength: number;
  tailThinkingLength: number;
  assistantRunToolUseCount: number;
  /** All loaded tool identities/results, used for block-level dedup. */
  persistedToolUseIds: Set<string>;
  persistedToolResultIds: Set<string>;
  /** Content fallback restricted to the latest still-pending interaction. */
  pendingInteractivePromptSignatures: Set<string>;
}

export function buildPersistedLiveReconciliation(
  messages: PersistedMessage[],
  precedingUserMessageId: number | null | undefined = null,
  fallbackResultIds: Iterable<string> = [],
): PersistedLiveReconciliation {
  const latestUserIndex = latestVisibleUserIndex(messages);
  const startsMidTurn = latestUserIndex < 0 && precedingUserMessageId != null;
  const assistantRun = messages
    .slice(latestUserIndex + 1)
    .filter((message) => message.role === 'assistant');
  const persistedToolUseIds = new Set<string>();
  const persistedToolResultIds = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'tool_use' && block.id) persistedToolUseIds.add(block.id);
      }
    } else if (message.role === 'tool') {
      for (const block of message.content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          persistedToolResultIds.add(block.tool_use_id);
        }
      }
    }
  }
  for (const id of fallbackResultIds) {
    if (id) persistedToolResultIds.add(id);
  }

  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  let assistantRunToolUseCount = 0;
  for (const message of assistantRun) {
    const text = getPersistedAssistantText(message);
    if (text.trim()) textParts.push(text);
    const thinking = getPersistedAssistantThinkingText(message);
    if (thinking.trim()) thinkingParts.push(thinking);
    for (const block of message.content) {
      if (block.type !== 'tool_use') continue;
      assistantRunToolUseCount++;
    }
  }

  const persistedText = textParts.join('\n').trim();
  const persistedThinking = thinkingParts.join('\n').trim();

  return {
    assistantRun,
    startsMidTurn,
    precedingUserMessageId: precedingUserMessageId ?? null,
    persistedText,
    persistedThinking,
    // Normalized once per history refetch, never per token frame.
    persistedTextNormalized: normalizeRunText(persistedText),
    persistedThinkingNormalized: normalizeRunText(persistedThinking),
    tailTextLength: assistantRun.length > 0
      ? getPersistedAssistantText(assistantRun[assistantRun.length - 1]).length
      : 0,
    tailThinkingLength: assistantRun.length > 0
      ? getPersistedAssistantThinkingText(assistantRun[assistantRun.length - 1]).length
      : 0,
    assistantRunToolUseCount,
    persistedToolUseIds,
    persistedToolResultIds,
    pendingInteractivePromptSignatures: collectLatestPersistedInteractivePromptSignatures(
      messages,
      persistedToolResultIds,
    ),
  };
}

export function persistedLiveReconciliation(
  history: PersistedMessage[] | PersistedLiveReconciliation,
  precedingUserMessageId?: number | null,
): PersistedLiveReconciliation {
  return Array.isArray(history)
    ? buildPersistedLiveReconciliation(history, precedingUserMessageId)
    : history;
}

const CROSS_USER_BOUNDARY_BLOCK_TYPES = new Set<StreamBlock['type']>([
  'activity',
  'agents',
  'task_run',
  'workflow',
]);

export function liveBlocksCoverPersistedAssistantRun(
  blocks: StreamBlock[],
  reconciliation: PersistedLiveReconciliation,
  anywhere: boolean,
): boolean {
  if (blocks.length === 0 || reconciliation.assistantRun.length === 0) return false;
  const liveText = normalizeRunText(getCurrentTurnText({ blocks }));
  const liveThinking = normalizeRunText(getCurrentTurnThinkingText({ blocks }));
  if (!normalizedCovers(
    liveText,
    reconciliation.persistedTextNormalized,
    anywhere,
  )) return false;
  if (!normalizedCovers(
    liveThinking,
    reconciliation.persistedThinkingNormalized,
    anywhere,
  )) return false;

  const liveIds = new Set<string>();
  const liveSignatures = new Set<string>();
  for (const block of blocks) {
    const id = liveBlockPersistedId(block);
    if (id) liveIds.add(id);
    const signature = liveBlockPersistedSignature(block);
    if (signature) liveSignatures.add(signature);
  }
  for (const message of reconciliation.assistantRun) {
    for (const block of message.content) {
      if (block.type !== 'tool_use') continue;
      if (block.id && liveIds.has(block.id)) continue;
      const signature = persistedInteractivePromptSignature(block.name, block.input);
      if (
        signature
        && reconciliation.pendingInteractivePromptSignatures.has(signature)
        && liveSignatures.has(signature)
      ) continue;
      return false;
    }
  }

  return Boolean(
    reconciliation.persistedText
    || reconciliation.persistedThinking
    || reconciliation.assistantRunToolUseCount > 0
  );
}

/**
 * Scope an accumulated live buffer to the assistant run after the latest user.
 *
 * `/inject` deliberately keeps the same worker and SSE stream alive. Older
 * workers did not emit a user-boundary event, so their `currentTurn` can still
 * contain the preceding user's text/tools when the durable history already has
 * a newer user row. Find the latest suffix that covers the newest persisted
 * assistant run and retain only it plus cross-turn live visualizations.
 */
export function scopeLiveTurnToLatestUser(
  turn: AssistantTurn | null,
  reconciliation: PersistedLiveReconciliation,
): AssistantTurn | null {
  if (
    !turn
    || turn.blocks.length === 0
    || reconciliation.startsMidTurn
    || reconciliation.assistantRun.length === 0
    || liveBlocksCoverPersistedAssistantRun(turn.blocks, reconciliation, false)
  ) return turn;

  for (let start = turn.blocks.length - 1; start > 0; start--) {
    const suffix = turn.blocks.slice(start);
    if (!liveBlocksCoverPersistedAssistantRun(suffix, reconciliation, false)) continue;
    const crossTurnBlocks = turn.blocks
      .slice(0, start)
      .filter((block) => CROSS_USER_BOUNDARY_BLOCK_TYPES.has(block.type));
    return { blocks: [...crossTurnBlocks, ...suffix] };
  }
  return turn;
}

/** Live blocks NOT yet represented in persisted history (dedup by id or prompt signature). */
export function visibleLiveBlocks(
  blocks: StreamBlock[],
  persistedIds: Set<string>,
  persistedInteractivePromptSignatures: Set<string> = new Set(),
  persistedResultIds: Set<string> = new Set(),
  preferCompleteLiveRun = false,
  reconciliation?: PersistedLiveReconciliation,
  /** The live buffer holds only a suffix of the run (cursorless reattach). */
  liveStartsMidTurn = false,
): StreamBlock[] {
  const effectiveBlocks = reconciliation
    ? (scopeLiveTurnToLatestUser({ blocks }, reconciliation)?.blocks ?? blocks)
    : blocks;
  const hasTaskRun = effectiveBlocks.some((block) => block.type === 'task_run');
  const liveAgentToolUseIds = new Set(
    effectiveBlocks.flatMap((block) => (
      block.type === 'agents' && block.group.toolUseId ? [block.group.toolUseId] : []
    )),
  );
  const hasPresentationOverlap = hasTaskRun || liveAgentToolUseIds.size > 0
    || effectiveBlocks.some((block) => block.type === 'agents' && block.group.groupId.startsWith('tasks-wave-'));
  const hasPersistedRunContent = Boolean(
    reconciliation?.persistedTextNormalized || reconciliation?.persistedThinkingNormalized,
  );
  if (
    persistedIds.size === 0
    && persistedInteractivePromptSignatures.size === 0
    && !hasPresentationOverlap
    && !hasPersistedRunContent
  ) return effectiveBlocks;
  // Whatever the durable transcript already renders must not render a second
  // time here. Cut the proven persisted prefix at its last ordered match and
  // append only the genuinely new live suffix after it.
  //
  // This runs on EVERY non-canonical path, not just a cold mid-turn replay:
  // when the coverage check declines, the persisted run renders above AND the
  // live copy renders below with its tool blocks removed by the id dedup at the
  // bottom of this filter — a text/thinking-only ghost of the same turn.
  let persistedOverlapPrefixEnd = -1;
  if (!preferCompleteLiveRun && reconciliation) {
    persistedOverlapPrefixEnd = persistedCoveragePrefixEnd(effectiveBlocks, {
      persistedTextNormalized: reconciliation.persistedTextNormalized,
      persistedThinkingNormalized: reconciliation.persistedThinkingNormalized,
      persistedIds,
      persistedSignatures: persistedInteractivePromptSignatures,
      blockId: liveBlockPersistedId,
      blockSignature: liveBlockPersistedSignature,
      anchorAnywhere: reconciliation.startsMidTurn || liveStartsMidTurn,
    });
  }
  return effectiveBlocks.filter((b, index) => {
    // `agents`/`task_run`/`workflow` are rich live cards that stay canonical
    // while they run (see below), so a covered prefix must not sweep them out by
    // position just because their spawn tool_use already checkpointed.
    if (
      index <= persistedOverlapPrefixEnd
      && b.type !== 'agents'
      && b.type !== 'task_run'
      && b.type !== 'workflow'
    ) return false;
    if (b.type === 'agents') {
      if (b.group.groupId.startsWith('tasks-wave-')) return false;
      if (preferCompleteLiveRun) return true;
      const toolUseId = b.group.toolUseId;
      // Once the completed group and its result are durable, the persisted
      // AgentsGroupBlock is canonical at the spawn tool's chronological
      // position. Keeping the accumulated live copy would move it to the very
      // end of the transcript, potentially below a later plan/card.
      if (
        b.group.status === 'completed'
        && toolUseId
        && persistedIds.has(toolUseId)
        && persistedResultIds.has(toolUseId)
      ) return false;
      // Task waves are already represented by TaskExecutionBlock. For genuine
      // subagents, the rich live card is canonical while it exists, even if
      // the parent tool_use has already checkpointed into history.
      return true;
    }
    if (
      b.type === 'tool'
      && (
        (hasTaskRun && b.call.name === 'execute_tasks')
        || (liveAgentToolUseIds.has(b.call.id)
          && ['spawn_agent', 'spawn_agents', 'resume_agent'].includes(b.call.name))
      )
    ) return false;
    // When the accumulated live buffer demonstrably covers the persisted
    // assistant tail, it is the canonical rendering for this in-flight run.
    // Filtering its persisted tool ids individually would punch holes in the
    // sequence (tools disappear while their preceding text moves to the end).
    if (preferCompleteLiveRun) return true;
    const id = liveBlockPersistedId(b);
    if (id && persistedIds.has(id)) return false;
    const signature = liveBlockPersistedSignature(b);
    return !(signature && persistedInteractivePromptSignatures.has(signature));
  });
}
