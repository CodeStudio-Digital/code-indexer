import type { VisualGroup } from '../types.js';
import { visualGroupKey } from './chapter-transcript.js';

export const MAX_TRANSCRIPT_ROW_BLOCKS = 4;
export interface AssistantTurnHeader {
  markdown: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
}
export interface TranscriptSegment {
  key: string;
  group: VisualGroup;
  header?: AssistantTurnHeader | false;
  last: boolean;
}
const segmentCache = new WeakMap<VisualGroup, TranscriptSegment[]>();

export function assistantTurnHeader(group: Extract<VisualGroup, { kind: 'assistant' }>): AssistantTurnHeader {
  const text: string[] = [];
  let input = 0, output = 0, cache = 0;
  for (const message of group.messages) {
    for (const block of message.content) if (block.type === 'text') text.push(block.text ?? '');
  }
  for (const usage of group.usages) {
    input += usage?.input_tokens ?? 0;
    output += usage?.output_tokens ?? 0;
    cache += usage?.cache_read_tokens ?? 0;
  }
  return { markdown: text.join('\n\n'), input_tokens: input, output_tokens: output, cache_read_tokens: cache };
}

/** Logical turns retain one copy/usage header while DOM rows remain bounded.
 * Keys derive from durable message identity and block offset, so prepending
 * older history does not remount the already visible content. */
export function splitTranscriptGroup(group: VisualGroup): TranscriptSegment[] {
  const cached = segmentCache.get(group);
  if (cached) return cached;
  if (group.kind === 'user') return [{ key: visualGroupKey(group), group, last: true }];
  if (group.messages.length === 1 && group.messages[0].content.length <= MAX_TRANSCRIPT_ROW_BLOCKS) {
    return [{ key: `${visualGroupKey(group)}:0`, group, last: true }];
  }
  const segments: TranscriptSegment[] = [];
  const header = assistantTurnHeader(group);
  group.messages.forEach((message, index) => {
    const id = group.usages[index]?.id ?? group.messageIds[index] ?? `unknown-${index}`;
    for (let offset = 0; offset < Math.max(1, message.content.length); offset += MAX_TRANSCRIPT_ROW_BLOCKS) {
      const content = message.content.slice(offset, offset + MAX_TRANSCRIPT_ROW_BLOCKS);
      segments.push({
        key: `assistant:${id}:${offset}`,
        group: { kind: 'assistant', messages: [{ ...message, content }],
          messageIds: [group.messageIds[index]], usages: [group.usages[index]],
          hasText: content.some(block => block.type === 'text' && Boolean(block.text?.trim())) },
        header: segments.length === 0 ? header : false,
        last: false,
      });
    }
  });
  if (segments.length) segments[segments.length - 1].last = true;
  segmentCache.set(group, segments);
  return segments;
}
