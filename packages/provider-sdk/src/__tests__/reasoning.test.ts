import { describe, expect, it } from 'vitest';
import type { ChatProvider, ChatRequest } from '../adapter.js';
import {
  nativeReasoningLevel,
  nativeReasoningLevels,
  resolveReasoningEffort,
  withReasoningCapabilities,
} from '../reasoning.js';

describe('reasoning policy', () => {
  it('keeps virtual Ultra out of native capability lists', () => {
    expect(nativeReasoningLevels(['low', 'max', 'ultra', 'MAX', null])).toEqual(['low', 'max']);
    expect(nativeReasoningLevel(' Ultra ')).toBeNull();
    expect(nativeReasoningLevel(' high ')).toBe('high');
  });

  it('maps Ultra to the highest native effort advertised by each model', () => {
    expect(resolveReasoningEffort({
      requestedEffort: 'ultra',
      capability: { canReason: true, supportedLevels: ['low', 'medium', 'high'] },
    })).toMatchObject({ effort: 'high', source: 'ultra-highest-supported' });

    expect(resolveReasoningEffort({
      executionMode: 'ultra',
      capability: { canReason: true, supportedLevels: ['high', 'xhigh', 'max'] },
    }).effort).toBe('max');
  });

  it('omits discrete effort for no-effort and unknown models in Ultra', () => {
    expect(resolveReasoningEffort({
      requestedEffort: 'ultra',
      capability: { canReason: false, supportedLevels: null },
    }).effort).toBeNull();
    expect(resolveReasoningEffort({ requestedEffort: 'ultra', capability: null }).effort).toBeNull();
    expect(resolveReasoningEffort({
      requestedEffort: 'ultra',
      capability: { canReason: true, supportedLevels: ['vendor-balanced', 'vendor-deep'] },
    }).effort).toBeNull();
  });

  it('preserves explicit native values only when known-supported or capability is unknown', () => {
    expect(resolveReasoningEffort({
      requestedEffort: 'xhigh',
      capability: { canReason: true, supportedLevels: ['low', 'high'] },
    }).effort).toBeNull();
    expect(resolveReasoningEffort({ requestedEffort: 'vendor-max', capability: null }).effort).toBe('vendor-max');
  });

  it('normalizes every request at the provider factory boundary and follows setModel', async () => {
    const seen: ChatRequest[] = [];
    const inner: ChatProvider = {
      name: 'fake',
      model: 'reasoner',
      setModel(model) { this.model = model; },
      async *chat(req) {
        seen.push(req);
        yield { type: 'text_delta', text: 'ok' };
      },
    };
    const wrapped = withReasoningCapabilities(inner, [
      { model_id: 'reasoner', can_reason: true, supported_reasoning_levels: ['low', 'high'] },
      { model_id: 'plain', can_reason: false, supported_reasoning_levels: null },
    ]);
    const request = { system: '', messages: [], tools: [], reasoningEffort: 'ultra', thinking: true } satisfies ChatRequest;

    for await (const _ of wrapped.chat(request)) { /* drain */ }
    wrapped.model = 'plain';
    for await (const _ of wrapped.chat(request)) { /* drain */ }

    expect(seen[0]?.reasoningEffort).toBe('high');
    expect(seen[0]?.thinking).toBe(true);
    expect(seen[1]?.reasoningEffort).toBeNull();
    expect(seen[1]?.thinking).toBeUndefined();
    expect(inner.model).toBe('plain');
    expect(JSON.stringify(seen)).not.toContain('"ultra"');
  });

  it('uses reasoning metadata for the active transport mode', async () => {
    const seen: ChatRequest[] = [];
    const inner: ChatProvider = {
      name: 'fake',
      model: 'shared::deep',
      setModel(model) { this.model = model; },
      async *chat(req) {
        seen.push(req);
        yield { type: 'text_delta', text: 'ok' };
      },
    };
    const wrapped = withReasoningCapabilities(inner, [
      { model_id: 'shared', mode: 'fast', can_reason: true, supported_reasoning_levels: ['low'] },
      { model_id: 'shared', mode: 'deep', can_reason: true, supported_reasoning_levels: ['low', 'xhigh'] },
    ]);

    // Metadata keeps the host mode, while a lazy/plugin provider receives only
    // the actual wire model before its first request.
    expect(inner.model).toBe('shared');

    for await (const _ of wrapped.chat({
      system: '', messages: [], tools: [], reasoningEffort: 'ultra',
    })) { /* drain */ }

    expect(seen[0]?.reasoningEffort).toBe('xhigh');

    wrapped.setModel('shared::missing');
    for await (const _ of wrapped.chat({
      system: '', messages: [], tools: [], reasoningEffort: 'ultra',
    })) { /* drain */ }
    expect(inner.model).toBe('shared');
    expect(seen[1]?.reasoningEffort).toBeNull();
  });

  it('enables boolean/fixed reasoning in Ultra for root, subagent, and model swaps', async () => {
    const seen: ChatRequest[] = [];
    const inner: ChatProvider = {
      name: 'fake',
      model: 'fixed-reasoner',
      setModel(model) { this.model = model; },
      async *chat(req) {
        seen.push(req);
        yield { type: 'text_delta', text: 'ok' };
      },
    };
    const wrapped = withReasoningCapabilities(inner, [
      { model_id: 'fixed-reasoner', can_reason: true, supported_reasoning_levels: null },
      { model_id: 'plain', can_reason: false, supported_reasoning_levels: null },
    ]);
    const ultraRequest = {
      system: '', messages: [], tools: [], reasoningEffort: 'ultra',
    } satisfies ChatRequest;

    for await (const _ of wrapped.chat(ultraRequest)) { /* drain */ }
    wrapped.setModel('plain');
    for await (const _ of wrapped.chat(ultraRequest)) { /* drain */ }

    expect(seen[0]).toMatchObject({ reasoningEffort: null, thinking: true });
    expect(seen[1]).toMatchObject({ reasoningEffort: null, thinking: undefined });
  });
});
