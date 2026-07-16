import { describe, expect, it } from 'vitest';
import {
  isNaturalLanguageSearch,
  searchEverywhereSupersessionKey,
} from '../SearchEverywhere.js';

describe('Search Everywhere semantic planning', () => {
  it.each([
    'how does the cache invalidate entries',
    'onde o token de acesso e validado',
    'cache invalidation strategy',
  ])('delays natural-language query for the hybrid stage: %s', (query) => {
    expect(isNaturalLanguageSearch(query)).toBe(true);
  });

  it.each([
    'invalidateCache',
    'src/cache/invalidate.ts',
    'CacheService.invalidate',
  ])('keeps identifier/path query on the immediate lexical stage: %s', (query) => {
    expect(isNaturalLanguageSearch(query)).toBe(false);
  });

  it('uses one project-scoped latest-wins queue for interactive reranking', () => {
    expect(searchEverywhereSupersessionKey(91)).toBe('search-everywhere:p91');
  });
});
