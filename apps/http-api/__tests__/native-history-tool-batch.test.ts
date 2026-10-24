import { expect, it } from 'vitest';
import { NativeHistoryToolBatch } from '../native-history-tool-batch.js';

it('keeps model order when independent reads finish in reverse order', () => {
  const batch = new NativeHistoryToolBatch();
  batch.stage({ role: 'assistant', content: ['slow', 'fast'].map(id => ({ type: 'tool_use', id, name: 'read_file', input: {} })) });
  expect(batch.accept({ id: 'fast', result: { content: 'second', isError: false, extraUserMessageHex: 'abcd' } })).toEqual([]);
  expect(batch.accept({ id: 'slow', result: { content: 'first', isError: false } }).map(item => item.id)).toEqual(['slow', 'fast']);
  expect(batch.drain()).toEqual([]);
});

it('rejects unmatched/duplicate results and exposes only committed partial results', () => {
  const batch = new NativeHistoryToolBatch();
  batch.stage({ role: 'assistant', content: ['slow', 'fast'].map(id => ({ type: 'tool_use', id, name: 'read_file', input: {} })) });
  const result = { id: 'fast', result: { content: 'done', isError: false } };
  expect(() => batch.accept({ ...result, id: 'foreign' })).toThrow('foreign');
  batch.accept(result);
  expect(() => batch.accept(result)).toThrow('duplicate');
  expect(() => batch.stage({ role: 'assistant', content: [{ type: 'text', text: 'next' }] })).toThrow('unsettled');
  expect(batch.drain()).toEqual([result]);
});
