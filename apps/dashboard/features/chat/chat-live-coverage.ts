import type { AssistantTurn, StreamBlock } from '../../hooks/useAgentStream.js';
import { hasTurnTokens } from '../../lib/turn-tokens.js';
import type { PersistedMessage, VisualGroup } from './types.js';
import { normalizeRunText, normalizedDuplicated } from './live-run-alignment.js';
import { type PersistedLiveReconciliation, persistedLiveReconciliation, scopeLiveTurnToLatestUser, liveBlocksCoverPersistedAssistantRun } from './chat-live-reconciliation.js';
import { getCurrentTurnText, getCurrentTurnThinkingText, liveBlockPersistedId } from './chat-message-text.js';
import { liveBlockPersistedSignature } from './chat-prompt-signatures.js';
import { isToolImagePlumbing } from './chat-message-grouping.js';

/**
 * Whether the live run may match the persisted one at any offset instead of from
 * its start. Two independent sources say the buffer holds only a suffix: history
 * paginated past the user message that opened the run, or the transport rebuilt
 * the buffer from a truncated replay (cursorless reattach).
 */
function liveRunMatchesAnywhere(
  turn: AssistantTurn,
  reconciliation: PersistedLiveReconciliation,
): boolean {
  return reconciliation.startsMidTurn || turn.startsMidTurn === true;
}

/**
 * True for a live-only visualization that has stopped moving. Terminal cards are
 * fully reconstructable from persisted history (or were never durable to begin
 * with), so they neither confirm nor refute that the live turn is a duplicate.
 */
function isTerminalPresentationBlock(block: StreamBlock): boolean {
  // A notice is renderer-only and never durable, so it is always transparent.
  if (block.type === 'notice') return true;
  if (block.type === 'activity') return block.status !== 'running';
  if (block.type === 'task_run' || block.type === 'workflow') {
    return block.run.status !== 'running';
  }
  return false;
}

export function isLiveTurnDuplicatedInHistory(
  turn: AssistantTurn | null,
  history: PersistedMessage[] | PersistedLiveReconciliation,
  persistedIds?: Set<string>,
  precedingUserMessageId?: number | null,
): boolean {
  if (!turn || turn.blocks.length === 0) return false;
  const reconciliation = persistedLiveReconciliation(history, precedingUserMessageId);
  if (reconciliation.assistantRun.length === 0) return false;
  const scopedTurn = scopeLiveTurnToLatestUser(turn, reconciliation);
  if (!scopedTurn || scopedTurn.blocks.length === 0) return false;
  const effectivePersistedIds = persistedIds ?? reconciliation.persistedToolUseIds;

  // Normalized on both sides — same block-boundary mismatch as the coverage
  // check above. Until this returns true `onClearCurrentTurn()` never fires, so
  // a raw-string miss leaves the live buffer on screen after the turn ended.
  const liveText = normalizeRunText(getCurrentTurnText(scopedTurn));
  const persistedText = reconciliation.persistedTextNormalized;
  const liveThinking = normalizeRunText(getCurrentTurnThinkingText(scopedTurn));
  const persistedThinking = reconciliation.persistedThinkingNormalized;
  const anywhere = liveRunMatchesAnywhere(turn, reconciliation);
  let checkedText = false;
  let checkedThinking = false;

  for (const block of scopedTurn.blocks) {
    if (block.type === 'usage') {
      if (!hasTurnTokens(block.tokens) || reconciliation.reportedTurnIds.has(block.id)) continue;
      return false;
    }
    // Running agents remain live-canonical. A completed group whose tool result
    // is already durable is fully reconstructable in persisted history and
    // must not keep the accumulated live run appended after newer content.
    if (block.type === 'agents') {
      const id = block.group.toolUseId;
      if (
        block.group.status === 'completed'
        && id
        && effectivePersistedIds.has(id)
        && reconciliation.persistedToolResultIds.has(id)
      ) continue;
      return false;
    }
    if (block.type === 'text') {
      if (!checkedText) {
        if (!normalizedDuplicated(persistedText, liveText, anywhere)) {
          return false;
        }
        checkedText = true;
      }
      continue;
    }
    if (block.type === 'thinking') {
      if (!checkedThinking) {
        if (!normalizedDuplicated(persistedThinking, liveThinking, anywhere)) {
          return false;
        }
        checkedThinking = true;
      }
      continue;
    }

    const id = liveBlockPersistedId(block);
    if (id) {
      if (effectivePersistedIds.has(id)) continue;
      const signature = liveBlockPersistedSignature(block);
      if (
        signature
        && reconciliation.pendingInteractivePromptSignatures.has(signature)
      ) continue;
      return false;
    }

    // activity/task_run/workflow are live-only visualizations with no durable
    // identity. While one is RUNNING the live card is canonical and the turn is
    // not a duplicate. Once terminal it proves nothing either way, so it must not
    // veto the comparison: a leftover `running` card used to make this return
    // false forever, which kept the live buffer on screen with the persisted run
    // suppressed behind it — the transcript then showed the live copy only.
    if (isTerminalPresentationBlock(block)) continue;
    return false;
  }

  return true;
}

/**
 * True when `currentTurn` still contains the complete assistant run that the
 * latest persisted history only checkpoints a prefix of. This is the normal
 * state after switching away from and back to a busy session: the GET becomes
 * newer while the per-session live buffer remains complete.
 */
export function liveTurnCoversPersistedAssistantRun(
  turn: AssistantTurn | null,
  history: PersistedMessage[] | PersistedLiveReconciliation,
  precedingUserMessageId?: number | null,
): boolean {
  if (!turn || turn.blocks.length === 0) return false;
  const reconciliation = persistedLiveReconciliation(history, precedingUserMessageId);
  const scopedTurn = scopeLiveTurnToLatestUser(turn, reconciliation);
  // A reconnect can replay the text but omit an earlier usage event. Keep
  // that history visible until the live buffer can replace its footers too.
  if (reconciliation.reportedTurnIds.size) {
    const liveIds = new Set(scopedTurn?.blocks.flatMap(block => block.type === 'usage' && hasTurnTokens(block.tokens) ? [block.id] : []));
    for (const id of reconciliation.reportedTurnIds) if (!liveIds.has(id)) return false;
  }
  return Boolean(
    scopedTurn
    && liveBlocksCoverPersistedAssistantRun(
      scopedTurn.blocks,
      reconciliation,
      liveRunMatchesAnywhere(turn, reconciliation),
    )
  );
}

/**
 * Hide only the checkpointed assistant groups belonging to the latest visible
 * user turn. The complete live run is rendered in their place, preserving the
 * original text/tool order while an active session continues streaming.
 */
export function suppressLatestPersistedAssistantRun(
  groups: VisualGroup[],
  precedingUserMessageId?: number | null,
): VisualGroup[] {
  let latestUserGroup = -1;
  for (let index = groups.length - 1; index >= 0; index--) {
    const group = groups[index];
    if (
      group.kind === 'user'
      && !group.message.isMeta
      && !isToolImagePlumbing(group.message)
    ) {
      latestUserGroup = index;
      break;
    }
  }
  if (latestUserGroup < 0) {
    if (precedingUserMessageId == null) return groups;
    const filtered = groups.filter((group) => group.kind !== 'assistant');
    return filtered.length === groups.length ? groups : filtered;
  }
  const filtered = groups.filter((group, index) => index <= latestUserGroup || group.kind !== 'assistant');
  return filtered.length === groups.length ? groups : filtered;
}
