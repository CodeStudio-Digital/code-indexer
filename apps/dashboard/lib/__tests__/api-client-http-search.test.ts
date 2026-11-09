import { expect, it } from 'vitest';
import { dottedToHttp } from '../api-client-http-routes.js';

it('preserves the semantic search caller and cache controls on HTTP', () => {
  const route = dottedToHttp('search.project', { projectId: 42, query: 'sessão expirada?',
    consumer: 'search_everywhere', supersessionKey: 'search:p42', bypassCache: true });
  const url = new URL(route!.url, 'http://localhost');
  expect(url.searchParams.get('q')).toBe('sessão expirada?');
  expect(url.searchParams.get('consumer')).toBe('search_everywhere');
  expect(url.searchParams.get('bypassCache')).toBe('1');
  expect(url.searchParams.get('supersessionKey')).toBe('search:p42');
});
