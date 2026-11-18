import { hasTurnTokens, type TurnTokens } from '../../../lib/turn-tokens.js';
import type { StreamBlock } from '../../../hooks/agent-stream/types.js';
import type { VisualGroup } from '../types.js';
import { visualGroupKey } from './chapter-transcript.js';

export const MAX_TRANSCRIPT_ROW_BLOCKS = 4;
/** A provider call may span several independently virtualized rows. */
export interface TurnFramePart {
  first: boolean;
  last: boolean;
  tokens: TurnTokens;
}
export interface TranscriptSegment {
  key: string;
  group: VisualGroup;
  frame?: TurnFramePart;
  copyMarkdown?: () => string;
  last: boolean;
}
const segmentCache = new WeakMap<VisualGroup, TranscriptSegment[]>();

export function assistantMarkdown(group: Extract<VisualGroup, { kind: 'assistant' }>): string {
  return group.messages.flatMap(message => message.content.flatMap(block =>
    block.type === 'text' && block.text ? [block.text] : [])).join('\n\n');
}

/** Each provider call owns its usage. Only the final segment of the user round
 * owns the copy action, which reads the Markdown when clicked. */
export function splitTranscriptGroup(group: VisualGroup): TranscriptSegment[] {
  const cached = segmentCache.get(group);
  if (cached) return cached;
  if (group.kind === 'user') return [{ key: visualGroupKey(group), group, last: true }];
  const segments: TranscriptSegment[] = [];
  group.messages.forEach((message, index) => {
    const id = group.usages[index]?.id ?? group.messageIds[index] ?? `unknown-${index}`;
    const tokens = group.usages[index];
    for (let offset = 0; offset < Math.max(1, message.content.length); offset += MAX_TRANSCRIPT_ROW_BLOCKS) {
      const single = group.messages.length === 1 && message.content.length <= MAX_TRANSCRIPT_ROW_BLOCKS;
      const content = single ? message.content : message.content.slice(offset, offset + MAX_TRANSCRIPT_ROW_BLOCKS);
      segments.push({
        key: `assistant:${id}:${offset}`,
        group: single ? group : { kind: 'assistant', messages: [{ ...message, content }],
          messageIds: [group.messageIds[index]], usages: [group.usages[index]],
          hasText: content.some(block => block.type === 'text' && Boolean(block.text?.trim())) },
        frame: hasTurnTokens(tokens) ? { tokens, first: offset === 0, last: offset + MAX_TRANSCRIPT_ROW_BLOCKS >= message.content.length } : undefined,
        last: false,
      });
    }
  });
  const last = segments.at(-1);
  if (last) {
    last.last = true;
    if (group.hasText) last.copyMarkdown = () => assistantMarkdown(group);
  }
  segmentCache.set(group, segments);
  return segments;
}

/** positionLiveUsage already places a completion after its matching tools.
 * Keep each content row (and its key) mounted when that completion arrives. */
export function liveTranscriptSegments(blocks: readonly StreamBlock[]) {
  const rows: { index: number; frame?: TurnFramePart }[] = [];
  let start = 0;
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (block.type !== 'usage') {
      rows.push({ index });
      continue;
    }
    if (hasTurnTokens(block.tokens)) {
      // Some providers report usage for a call with no visible content.
      if (start === rows.length) rows.push({ index });
      for (let i = start; i < rows.length; i++) {
        rows[i].frame = { first: i === start, last: i === rows.length - 1, tokens: block.tokens };
      }
    }
    start = rows.length;
  }
  return rows;
}
