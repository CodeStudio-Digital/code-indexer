import { expect, it, vi } from 'vitest';
import { boundedToolResultData } from '../bounded-tool-result-data.js';

it('preserves JSON values and shared objects without sharing mutable references', () => {
  const shared = { value: 'é\\"' }, input = { a: shared, b: shared, missing: undefined, array: [1, true, null, undefined] };
  const result = boundedToolResultData(input, 1024);
  expect(JSON.parse(JSON.stringify(result.structuredData))).toEqual({ a: shared, b: shared, array: [1, true, null, null] });
  shared.value = 'changed'; expect(JSON.stringify(result.structuredData)).not.toContain('changed');
});

it('rejects cycles, non-JSON numbers and accessor values without executing the accessor', () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  const getter = vi.fn(() => 'unsafe'), accessor = Object.defineProperty({}, 'value', { enumerable: true, get: getter });
  for (const value of [cycle, { value: Number.NaN }, { value: 1n }, accessor]) {
    expect(boundedToolResultData(value, 1024)).toEqual({ structuredDataOmitted: 'invalid' });
  }
  expect(getter).not.toHaveBeenCalled();
});

it('bounds encoded text, graph depth and node counts', () => {
  let nested: unknown = 'x'; for (let n = 0; n < 30; n++) nested = { nested };
  for (const value of ['x'.repeat(1025), '\\'.repeat(600), nested, Array(9000).fill(null)]) {
    expect(boundedToolResultData(value, 1024)).toEqual({ structuredDataOmitted: 'too_large' });
  }
});
