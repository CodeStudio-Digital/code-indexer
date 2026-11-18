import { describe, expect, it } from 'vitest';
import type { ContentBlock, VisualGroup } from '../../types.js';
import { mergeConsecutiveAssistantGroups } from '../../chat-message-grouping.js';
import { liveTranscriptSegments, MAX_TRANSCRIPT_ROW_BLOCKS, splitTranscriptGroup } from '../transcript-segments.js';
import { projectChapterSource } from '../MessageList.js';
import { selectionRange } from '../transcript-selection.js';

function assistant(seq: number, content: ContentBlock[]): Extract<VisualGroup, { kind: 'assistant' }> {
  return { kind: 'assistant', hasText: content.some(block => block.type === 'text'),
    messages: [{ role: 'assistant', content }], messageIds: [seq],
    usages: [{ id: `row-${seq}`, seq, input_tokens: 3, output_tokens: 5, cache_read_tokens: 2 }] };
}

describe('bounded persisted transcript segments', () => {
  it('bounds one assistant message with thousands of blocks without losing order, IDs or card inputs', () => {
    const content: ContentBlock[] = Array.from({ length: 5001 }, (_, index) => index % 2 === 0
      ? { type: 'text', text: `part-${index}` }
      : { type: 'tool_use', id: `call-${index}`, name: 'submit_plan', input: { plan: `plan-${index}` } });
    const group = assistant(10, content);
    const segments = splitTranscriptGroup(group);
    expect(segments).toHaveLength(Math.ceil(content.length / MAX_TRANSCRIPT_ROW_BLOCKS));
    const blocks = segments.flatMap(segment => segment.group.kind === 'assistant' ? segment.group.messages.flatMap(message => message.content) : []);
    expect(blocks).toHaveLength(content.length);
    blocks.forEach((block, index) => expect(block).toBe(content[index]));
    expect(segments.every(segment => segment.group.kind === 'assistant' && segment.group.messages[0].content.length <= MAX_TRANSCRIPT_ROW_BLOCKS)).toBe(true);
    expect(new Set(segments.map(segment => segment.key)).size).toBe(segments.length);
    expect(segments.filter(segment => segment.last)).toEqual([segments.at(-1)]);
    expect(segments.filter(segment => segment.frame?.first)).toEqual([segments[0]]);
    expect(segments.filter(segment => segment.frame?.last)).toEqual([segments.at(-1)]);
    expect(segments.every(segment => segment.frame?.tokens === group.usages[0])).toBe(true);
    expect(segments.filter(segment => segment.copyMarkdown)).toEqual([segments.at(-1)]);
    expect(segments.at(-1)?.copyMarkdown?.()).toBe(content.filter(block => block.type === 'text').map(block => block.text).join('\n\n'));
  });

  it('keeps one information button per provider call and one complete Markdown action for the whole reply', () => {
    const originals = Array.from({ length: 2000 }, (_, index) => assistant(index + 2, [{ type: 'text', text: `cycle-${index}` }]));
    // Production groups/messages are immutable snapshots. Merging must not edit
    // the input arrays or rebuild the growing prefix for every provider cycle.
    originals.forEach(group => { Object.freeze(group.messages); Object.freeze(group.messageIds); Object.freeze(group.usages); Object.freeze(group); });
    const merged = mergeConsecutiveAssistantGroups(originals);
    expect(merged).toHaveLength(1);
    const segments = splitTranscriptGroup(merged[0]);
    expect(segments).toHaveLength(originals.length);
    expect(segments.map(segment => segment.frame)).toEqual(originals.map(group => ({ first: true, last: true, tokens: group.usages[0] })));
    expect(segments.slice(0, -1).every(segment => !segment.copyMarkdown)).toBe(true);
    expect(segments.at(-1)?.copyMarkdown?.()).toBe(originals.map(group => group.messages[0].content[0].text).join('\n\n'));
    const earlier: VisualGroup = { kind: 'user', messageId: 1, message: { role: 'user', content: [{ type: 'text', text: 'request' }] } };
    const withEarlier = mergeConsecutiveAssistantGroups([earlier, ...originals]);
    expect(splitTranscriptGroup(withEarlier[1]).map(segment => segment.key)).toEqual(segments.map(segment => segment.key));
    expect(splitTranscriptGroup(earlier)[0].group).toBe(earlier);
    originals.forEach(group => expect(group.messages).toHaveLength(1));
  });

  it('frames live reasoning and tools together while the next unfinished call keeps its own rows', () => {
    const first = { input_tokens: 12, output_tokens: 3 };
    const second = { input_tokens: 21, output_tokens: 4 };
    const pending = { type: 'text' as const, text: 'Writing' };
    const rows = liveTranscriptSegments([
      { type: 'thinking', text: 'Reading' },
      { type: 'tool', call: { id: 'a', name: 'read_file', status: 'done', startedAt: 0 } },
      { type: 'usage', id: 'one', toolIds: ['a'], tokens: first },
      { type: 'text', text: 'Read' },
      { type: 'usage', id: 'two', toolIds: [], tokens: second },
      pending,
    ]);
    expect(rows).toEqual([
      { index: 0, frame: { first: true, last: false, tokens: first } },
      { index: 1, frame: { first: false, last: true, tokens: first } },
      { index: 3, frame: { first: true, last: true, tokens: second } },
      { index: 5 },
    ]);
    const zero = { input_tokens: 0, output_tokens: 0 };
    expect(liveTranscriptSegments([pending, { type: 'usage', id: 'zero', toolIds: [], tokens: zero },
      { type: 'usage', id: 'cache', toolIds: [], tokens: { ...zero, cache_read_tokens: 1 } }]))
      .toEqual([{ index: 0 }, { index: 2, frame: { first: true, last: true, tokens: { ...zero, cache_read_tokens: 1 } } }]);
  });

  it('keeps tool results paired by ID across segments and page boundaries', () => {
    const projection = projectChapterSource([
      { id: 'r1', seq: 1, role: 'assistant', content: [
        { type: 'text', text: 'Checking' },
        { type: 'tool_use', id: 'paired', name: 'read_file', input: { path: 'a.ts' } },
        { type: 'tool_use', id: 'outside-page', name: 'read_file', input: { path: 'b.ts' } },
      ] },
      { id: 'r2', seq: 2, role: 'tool', content: [{ type: 'tool_result', tool_use_id: 'paired', content: 'file a', is_error: false }] },
      { id: 'r3', seq: 3, role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
    ], [{ tool_use_id: 'outside-page', content: 'file b', is_error: true, _truncated: true, _originalLength: 50000 }]);
    const segments = splitTranscriptGroup(projection.groups[0]);
    const calls = segments.flatMap(segment => segment.group.kind === 'assistant'
      ? segment.group.messages.flatMap(message => message.content).filter(block => block.type === 'tool_use') : []);
    expect(calls.map(call => projection.resultsById.get(call.id!))).toEqual([
      { content: 'file a', isError: false, truncated: false, originalLength: undefined },
      { content: 'file b', isError: true, truncated: true, originalLength: 50000 },
    ]);
  });

  it('retains only selected DOM rows outside the viewport and releases them after selection clears', () => {
    const range = { startIndex: 20, endIndex: 22, overscan: 1, count: 50 };
    expect(selectionRange(range, [1, 2, 21, 100, -1])).toEqual([1, 2, 19, 20, 21, 22, 23]);
    expect(selectionRange(range, [])).toEqual([19, 20, 21, 22, 23]);
  });

  it('keeps the edit summary attached to the original user round when a source page starts mid-turn', () => {
    const projection = projectChapterSource([
      { id: 'edit-row', seq: 125, role: 'assistant', content: [{ type: 'tool_use', id: 'edit', name: 'edit_file', input: { path: 'src/main.ts' } }] },
    ], [], 97);
    expect(projection.summaries.get(0)).toEqual({ roundMessageId: 97, paths: [{ path: 'src/main.ts', op: 'edit' }] });
  });
});
