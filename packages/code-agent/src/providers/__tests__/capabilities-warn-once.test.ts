/**
 * A model without a known context window is reported once per model, not on
 * every lookup: the runner resolves the window several times per turn, and a
 * genuinely unknown model would otherwise flood the log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEffectiveContextWindow } from '../capabilities.js';

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterEach(() => warn.mockRestore());

const warningsFor = (model: string) => warn.mock.calls.filter((call: unknown[]) => String(call[0]).includes(`"${model}"`)).length;

describe('context window warnings', () => {
  it('warns once per unknown model, whatever the number of lookups', () => {
    for (let i = 0; i < 5; i++) getEffectiveContextWindow('warn-once-unknown-a');
    getEffectiveContextWindow('warn-once-unknown-b');
    expect(warningsFor('warn-once-unknown-a')).toBe(1);
    expect(warningsFor('warn-once-unknown-b')).toBe(1);
    expect(getEffectiveContextWindow('warn-once-unknown-a')).toMatchObject({ source: 'fallback', window: 128_000 });
  });

  it('warns once per model on the family-heuristic path too', () => {
    for (let i = 0; i < 3; i++) getEffectiveContextWindow('claude-warn-once-mysterious-7');
    expect(warningsFor('claude-warn-once-mysterious-7')).toBe(1);
  });
});
