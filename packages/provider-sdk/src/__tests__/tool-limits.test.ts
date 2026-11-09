import { describe, expect, it } from 'vitest';
import type { ChatProvider } from '../adapter.js';
import { withReasoningCapabilities } from '../reasoning.js';
import { withStreamResilience } from '../stream-resilience.js';

describe('provider wrapper limits', () => {
  it('preserves attested limits through both wrappers and model changes', () => {
    let limits = { maxNameChars: 64, source: 'fixture-adapter' };
    const provider: ChatProvider = {
      name: 'fixture', model: 'one',
      get toolLimits() { return limits; },
      setModel(model) { this.model = model; },
      async *chat() { yield { type: 'done' }; },
    };
    const wrapped = withStreamResilience(withReasoningCapabilities(provider, []));
    expect(wrapped.toolLimits).toBe(provider.toolLimits);
    limits = { maxNameChars: 32, source: 'fixture-model-two' };
    wrapped.setModel('two');
    expect(wrapped.toolLimits).toBe(provider.toolLimits);
    expect(wrapped.toolLimits?.maxNameChars).toBe(32);
  });

  it('does not invent limits for compatible endpoints', () => {
    const provider: ChatProvider = {
      name: 'fixture', model: 'one', setModel() {},
      async *chat() { yield { type: 'done' }; },
    };
    expect(withStreamResilience(withReasoningCapabilities(provider, [])).toolLimits).toBeUndefined();
  });
});
