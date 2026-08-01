import { afterEach, describe, expect, it } from 'vitest';
import {
  normalizeDynamicToolPins,
  promoteDynamicToolPin,
  resolveDynamicToolPinLimit,
  touchDynamicToolPin,
} from '../tool-pin-window.js';

afterEach(() => {
  delete process.env.CODER_DYNAMIC_TOOL_PIN_LIMIT;
});

describe('dynamic tool pin window', () => {
  it('evicts the least-recently-used dynamic pin and preserves required pins', () => {
    const required = new Set(['required']);
    const pins = new Set(['required', 'old', 'warm']);

    touchDynamicToolPin(pins, required, 'old');
    const evicted = promoteDynamicToolPin(pins, required, 'new', 2);

    expect(evicted).toEqual(['warm']);
    expect([...pins]).toEqual(['required', 'old', 'new']);
  });

  it('bounds restored pins while keeping the newest entries', () => {
    const pins = new Set(['required', 'a', 'b', 'c']);
    const evicted = normalizeDynamicToolPins(pins, new Set(['required']), 2);
    expect(evicted).toEqual(['a']);
    expect([...pins]).toEqual(['required', 'b', 'c']);
  });

  it('parses and clamps the runtime limit', () => {
    process.env.CODER_DYNAMIC_TOOL_PIN_LIMIT = '999';
    expect(resolveDynamicToolPinLimit()).toBe(64);
    process.env.CODER_DYNAMIC_TOOL_PIN_LIMIT = '0';
    expect(resolveDynamicToolPinLimit()).toBe(1);
  });
});

