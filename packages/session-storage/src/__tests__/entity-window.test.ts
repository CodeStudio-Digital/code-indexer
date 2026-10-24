import { expect, it } from 'vitest';
import { entityWindow } from '../fs-store/entity-window.js';

it('selects the requested sorted filtered window from a larger unordered stream', async () => {
  async function* source() { for (let i = 10_000; i > 0; i--) yield i; }
  expect(await entityWindow(source(), { limit: 3, offset: 2, compare: (a, b) => a - b, filter: i => i % 2 === 0 })).toEqual([6, 8, 10]);
});
it('rejects invalid windows before reading the source', async () => {
  async function* source() { throw new Error('must not open source'); yield 1; }
  await expect(entityWindow(source(), { limit: NaN, compare: (a, b) => a - b })).rejects.toThrow('Invalid entity window');
});
