import type { AssistantTurn, StreamBlock } from '../../hooks/useAgentStream.js';
import { TEXT_LIKE_EXTS } from './constants.js';
import type { AgentAttachment, MessageRow, PersistedMessage, VisualGroup } from './types.js';

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m${rs > 0 ? ` ${rs}s` : ''}`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h${rm > 0 ? ` ${rm}m` : ''}`;
}

export function fileToAttachment(file: File): Promise<AgentAttachment> {
  return new Promise((resolve, reject) => {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    const isImage = file.type.startsWith('image/');
    const isText =
      file.type.startsWith('text/') || file.type === 'application/json' || TEXT_LIKE_EXTS.has(ext);
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    if (isText) {
      reader.onload = () =>
        resolve({
          name: file.name,
          mediaType: file.type || 'text/plain',
          text: String(reader.result ?? ''),
        });
      reader.readAsText(file);
    } else {
      reader.onload = () => {
        const result = String(reader.result ?? '');
        const base64 = result.includes(',') ? result.split(',', 2)[1] : result;
        resolve({
          name: file.name,
          mediaType: file.type || (isImage ? 'image/png' : 'application/octet-stream'),
          base64,
        });
      };
      reader.readAsDataURL(file);
    }
  });
}

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

// ─── Visual grouping ────────────────────────────────────────────

/**
 * Sentinel text of the synthetic user message the runner injects after a tool
 * that returned an image (view_image / preview_screenshot) — see
 * `executing.ts`. The image is plumbing the MODEL needs as a user/image block;
 * in the transcript we hide this bubble and instead render the image INLINE
 * under the tool call (so it survives reload, matching the live stream).
 */
export const TOOL_IMAGE_SENTINEL = '(Image(s) attached from the tool call above.)';

/** Tools that emit a tool-result image surfaced via the synthetic user msg. */
export const IMAGE_PRODUCER_TOOLS = new Set(['preview_screenshot', 'view_image']);

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

    if (msg.role === 'user') {
      flushPending();
      groups.push({ kind: 'user', message: msg, messageId: row?.id, usage: row });
      continue;
    }

    // assistant
    if (messageHasText(msg)) {
      flushPending();
      groups.push({
        kind: 'assistant',
        messages: [msg],
        messageIds: [row?.id],
        usages: [row],
        hasText: true,
      });
    } else {
      // tool-only assistant turn → accumulate
      if (!pending) {
        pending = { messages: [], messageIds: [], usages: [] };
      }
      pending.messages.push(msg);
      pending.messageIds.push(row?.id);
      pending.usages.push(row);
    }
  }
  flushPending();
  return groups;
}
