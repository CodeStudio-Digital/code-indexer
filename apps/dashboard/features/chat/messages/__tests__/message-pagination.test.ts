import { describe, expect, it } from 'vitest';
import { shouldLoadEarlierAtScrollTop } from '../MessageList.js';

describe('conversation scroll pagination', () => {
  it.each([
    [-12, true],
    [0, true],
    [199, true],
    [200, true],
    [201, false],
    [900, false],
  ])('scrollTop %s => load earlier %s', (scrollTop, expected) => {
    expect(shouldLoadEarlierAtScrollTop(scrollTop)).toBe(expected);
  });
});
