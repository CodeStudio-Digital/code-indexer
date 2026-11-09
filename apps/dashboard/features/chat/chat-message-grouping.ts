import type { MessageRow, PersistedMessage, VisualGroup } from './types.js';

// ─── Visual grouping ────────────────────────────────────────────

/**
 * Sentinel text of the synthetic user message the runner injects after a tool
 * that returned an image (view_image / preview_screenshot) — see
 * `executing.ts`. The image is plumbing the MODEL needs as a user/image block;
 * in the transcript we hide this bubble and instead render the image INLINE
 * under the tool call (so it survives reload, matching the live stream).
 */
const TOOL_IMAGE_SENTINEL = '(Image(s) attached from the tool call above.)';

/** True when a message is the synthetic tool-image plumbing bubble. */
export function isToolImagePlumbing(msg: PersistedMessage): boolean {
  return (
    msg.role === 'user' &&
    msg.content.some((b) => b.type === 'image') &&
    msg.content.some((b) => b.type === 'text' && (b.text ?? '').trim() === TOOL_IMAGE_SENTINEL)
  );
}

function messageHasText(msg: PersistedMessage): boolean {
  return msg.content.some((b) => b.type === 'text' && (b.text ?? '').trim().length > 0);
}

/**
 * Group flat persisted messages into visual groups for rendering.
 * Consecutive assistant messages that contain only tool_use blocks (no text)
 * are merged into a single visual group. An assistant message with text
 * always starts its own standalone group.
 */
export function groupMessages(
  messages: PersistedMessage[],
  messageRows: MessageRow[],
): VisualGroup[] {
  const groups: VisualGroup[] = [];
  let pending: {
    messages: PersistedMessage[];
    messageIds: (number | undefined)[];
    usages: (MessageRow | undefined)[];
  } | null = null;

  const flushPending = () => {
    if (!pending) return;
    groups.push({
      kind: 'assistant',
      messages: pending.messages,
      messageIds: pending.messageIds,
      usages: pending.usages,
      hasText: false,
    });
    pending = null;
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const row = messageRows[i];

    if (msg.role === 'tool') continue;

    // Meta inputs are model/runtime plumbing. They remain persisted and are
    // still available to the runner and diagnostics, but must never be shown
    // as if the user typed them.
    if (msg.role === 'user' && msg.isMeta) continue;

    if (msg.role === 'user') {
      flushPending();
      groups.push({
        kind: 'user',
        message: msg,
        // Optimistic sequences are client-only. Do not expose fork/rollback or
        // lazy attachment endpoints until the authoritative row replaces them.
        messageId: row?.optimistic ? undefined : row?.seq,
        usage: row,
      });
      continue;
    }

    // assistant
    if (messageHasText(msg)) {
      flushPending();
      groups.push({
        kind: 'assistant',
        messages: [msg],
        messageIds: [row?.seq],
        usages: [row],
        hasText: true,
      });
    } else {
      // tool-only assistant turn → accumulate
      if (!pending) {
        pending = { messages: [], messageIds: [], usages: [] };
      }
      pending.messages.push(msg);
      pending.messageIds.push(row?.seq);
      pending.usages.push(row);
    }
  }
  flushPending();
  return groups;
}

/**
 * A model can make many provider/tool cycles before the user speaks again.
 * Persist those cycles independently, but present them as one assistant turn
 * with one header. Rendering splits the logical turn into bounded virtual
 * segments; grouping must not repeatedly copy the growing turn arrays.
 */
export function mergeConsecutiveAssistantGroups(groups: VisualGroup[]): VisualGroup[] {
  const merged: VisualGroup[] = [];
  let owned: Extract<VisualGroup, { kind: 'assistant' }> | null = null;
  for (const group of groups) {
    const previous = merged[merged.length - 1];
    if (group.kind === 'assistant' && previous?.kind === 'assistant') {
      if (owned !== previous) {
        owned = { ...previous, messages: [...previous.messages],
          messageIds: [...previous.messageIds], usages: [...previous.usages] };
        merged[merged.length - 1] = owned;
      }
      // Avoid spread argument limits for unusually large imported histories.
      for (const message of group.messages) owned.messages.push(message);
      for (const id of group.messageIds) owned.messageIds.push(id);
      for (const usage of group.usages) owned.usages.push(usage);
      owned.hasText ||= group.hasText;
    } else {
      merged.push(group);
      owned = null;
    }
  }
  return merged;
}

/** True when the live buffer continues the already-persisted assistant run. */
export function liveTurnContinuesPersistedAssistant(messages: PersistedMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === 'tool') continue;
    // Runner plumbing/meta input does not represent a new visible user turn.
    if (message.role === 'user' && (message.isMeta || isToolImagePlumbing(message))) continue;
    return message.role === 'assistant';
  }
  return false;
}

export interface LiveAgentIdentity {
  toolUseId?: string;
  groupId: string;
}

/**
 * Prefer a rich live AgentsGroupBlock over the checkpointed spawn_agent card
 * for the same execution. The persisted card returns naturally as soon as the
 * live group leaves currentTurn; no history is deleted or mutated.
 */
export function suppressPersistedAgentDuplicates(
  groups: VisualGroup[],
  liveIdentities: LiveAgentIdentity[],
  resultsById: ReadonlyMap<string, { content?: string }>,
): VisualGroup[] {
  if (liveIdentities.length === 0) return groups;

  const liveToolIds = new Set(liveIdentities.flatMap((identity) => identity.toolUseId ? [identity.toolUseId] : []));
  const liveGroupIds = new Set(liveIdentities.map((identity) => identity.groupId));
  const shouldSuppress = (block: PersistedMessage['content'][number]): boolean => {
    if (
      block.type !== 'tool_use'
      || (block.name !== 'spawn_agent' && block.name !== 'spawn_agents')
    ) return false;
    if (block.id && liveToolIds.has(block.id)) return true;
    const resultText = block.id ? resultsById.get(block.id)?.content ?? '' : '';
    const groupId = persistedAgentGroupId(resultText);
    return Boolean(groupId && liveGroupIds.has(groupId));
  };

  const reconciled: VisualGroup[] = [];
  for (const group of groups) {
    if (group.kind === 'user') {
      reconciled.push(group);
      continue;
    }
    const messages: PersistedMessage[] = [];
    const messageIds: (number | undefined)[] = [];
    const usages: (MessageRow | undefined)[] = [];
    group.messages.forEach((message, index) => {
      const content = message.content.filter((block) => !shouldSuppress(block));
      if (content.length === 0) return;
      messages.push(content.length === message.content.length ? message : { ...message, content });
      messageIds.push(group.messageIds[index]);
      usages.push(group.usages[index]);
    });
    if (messages.length === 0) continue;
    reconciled.push({
      kind: 'assistant',
      messages,
      messageIds,
      usages,
      hasText: messages.some(messageHasText),
    });
  }
  return reconciled;
}

function persistedAgentGroupId(content: string): string | undefined {
  return content.match(/^\[spawn_agent background\][^\n]*\bgroup=(\S+)/m)?.[1]
    ?? content.match(/\[parallel agents:[^\]]*\bgroup=([^,\s\]]+)/)?.[1]
    ?? content.match(/\[subagent [^\]]*\bspawn=([^\s\]]+)/)?.[1];
}
