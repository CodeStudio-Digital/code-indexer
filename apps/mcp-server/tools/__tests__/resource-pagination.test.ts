import { expect, it } from 'vitest';
import { resourcePage } from '../../resources/page.js';

it('recovers every entry across bounded protocol pages', () => {
  const catalog = Array.from({ length: 251 }, (_, n) => ({ uri: 'mcp://' + n.toString().padStart(4, '0') }));
  const first = resourcePage(catalog, 'resources'); expect(first.items).toHaveLength(100);
  const second = resourcePage(catalog, 'resources', first.nextCursor); expect(second.items).toHaveLength(100);
  const third = resourcePage(catalog, 'resources', second.nextCursor); expect(third.items).toHaveLength(51);
  expect(third.nextCursor).toBeUndefined(); expect([...first.items, ...second.items, ...third.items]).toEqual(catalog);
});

it('rejects stale, cross-kind, and malformed cursors', () => {
  const catalog = Array.from({ length: 101 }, (_, n) => ({ uri: 'mcp://' + n }));
  const cursor = resourcePage(catalog, 'resources').nextCursor;
  expect(() => resourcePage(catalog.slice(1), 'resources', cursor)).toThrow('catalog changed');
  expect(() => resourcePage(catalog, 'templates', cursor)).toThrow('catalog changed');
  expect(() => resourcePage(catalog, 'resources', 'broken')).toThrow('Invalid');
  expect(() => resourcePage(catalog, 'resources', Buffer.from('{"offset":-1}').toString('base64url'))).toThrow('Invalid');
});
