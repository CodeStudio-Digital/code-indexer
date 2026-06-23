import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ResolvedCreds } from '@mcp/provider-sdk';

// Capture constructor args so we can assert the engine builds the SAME adapter
// the hand-written definition does. Both the definition and the engine import
// these exact specifiers, so one mock intercepts both.
const chatCalls: Array<Record<string, unknown>> = [];
const idxCalls: Array<{ cls: string; args: unknown[] }> = [];

vi.mock('@mcp/code-agent/providers/anthropic.js', () => ({
  AnthropicChatProvider: vi.fn().mockImplementation(function (opts: Record<string, unknown>) {
    chatCalls.push(opts);
  }),
}));
vi.mock('@mcp/indexer/indexer/providers/anthropic.js', () => ({
  AnthropicProvider: vi.fn().mockImplementation(function (...args: unknown[]) {
    idxCalls.push({ cls: 'AnthropicProvider', args });
  }),
}));

import { anthropic } from '@mcp/services/providers/definitions/anthropic.js';
import { buildAnthropic } from '../wires/anthropic.js';
import { anthropicSpec } from '../specs/anthropic.js';

/** Trailing `undefined` args == not passing them (optional ctor params). */
function stripTrailingUndefined(args: unknown[]): unknown[] {
  const out = [...args];
  while (out.length > 0 && out[out.length - 1] === undefined) out.pop();
  return out;
}

// Representative creds: a custom baseURL plus an explicit summary_model override
// to exercise both the baseURL pass-through and the `extra.summary_model` branch.
// (The default-summary branch is covered by the no-extra creds below.)
const CREDS: ResolvedCreds = {
  apiKey: 'k',
  baseURL: 'https://custom.anthropic/v1',
  extra: { summary_model: 'claude-haiku-future' },
};
const CREDS_DEFAULTS: ResolvedCreds = { apiKey: 'k' };

describe('anthropic equivalence: engine(spec) == definition', () => {
  beforeEach(() => {
    chatCalls.length = 0;
    idxCalls.length = 0;
  });

  it('metadata matches', () => {
    expect(anthropicSpec.kind).toBe(anthropic.kind);
    expect(anthropicSpec.displayName).toBe(anthropic.displayName);
    expect(anthropicSpec.credKind).toBe(anthropic.credKind);
    expect(anthropicSpec.envVars).toEqual(anthropic.envVars);
    expect(anthropicSpec.defaultBaseURL).toBe(anthropic.defaultBaseURL);
    expect(anthropicSpec.defaultModels).toEqual(anthropic.defaultModels);
    expect(anthropicSpec.defaultModel).toBe(anthropic.defaultModel);
    expect(anthropicSpec.pricing).toEqual(anthropic.pricing);
    expect(anthropicSpec.capabilities).toEqual(anthropic.capabilities);
    expect(anthropicSpec.visual).toEqual(anthropic.visual);
  });

  it('createCoder builds an identical adapter (model passed)', () => {
    const engine = buildAnthropic(anthropicSpec);
    anthropic.createCoder!(CREDS, 'claude-opus-4-6-20260320');
    const a = chatCalls[0];
    engine.createCoder!(CREDS, 'claude-opus-4-6-20260320');
    const b = chatCalls[1];
    expect(b).toEqual(a);
  });

  it('createCoder builds an identical adapter (model omitted → defaultModel)', () => {
    const engine = buildAnthropic(anthropicSpec);
    anthropic.createCoder!(CREDS, undefined);
    const a = chatCalls[0];
    engine.createCoder!(CREDS, undefined);
    const b = chatCalls[1];
    expect(b).toEqual(a);
    // Pins the wireOpts lift: default thinking + sonnet default.
    expect(b.model).toBe('claude-sonnet-4-6');
    expect(b.defaultThinking).toEqual({ type: 'enabled', budget_tokens: 32000 });
    expect(b.baseURL).toBe('https://custom.anthropic/v1');
  });

  it('createIndexer builds an identical adapter (summary_model override)', () => {
    const engine = buildAnthropic(anthropicSpec);
    anthropic.createIndexer!(CREDS, 'claude-opus-4-6-20260320');
    const a = idxCalls[0];
    engine.createIndexer!(CREDS, 'claude-opus-4-6-20260320');
    const b = idxCalls[1];
    expect(b.cls).toBe(a.cls);
    expect(stripTrailingUndefined(b.args)).toEqual(stripTrailingUndefined(a.args));
  });

  it('createIndexer builds an identical adapter (default summary model)', () => {
    const engine = buildAnthropic(anthropicSpec);
    anthropic.createIndexer!(CREDS_DEFAULTS, undefined);
    const a = idxCalls[0];
    engine.createIndexer!(CREDS_DEFAULTS, undefined);
    const b = idxCalls[1];
    expect(b.cls).toBe(a.cls);
    expect(stripTrailingUndefined(b.args)).toEqual(stripTrailingUndefined(a.args));
    // 4th arg is the OPTIONS OBJECT (not positional) carrying the cheap default.
    expect(b.args[3]).toEqual({ summaryModel: 'claude-haiku-4-5-20251001' });
  });
});
