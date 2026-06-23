import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ResolvedCreds, ProviderDefinition, ProviderSpec } from '@mcp/provider-sdk';

// Capture constructor args so we can assert the engine builds the SAME adapter
// the hand-written definition does. Both the definition and the engine import
// these exact specifiers, so one mock intercepts both.
const chatCalls: Array<{ cls: string; args: unknown[] }> = [];
const idxCalls: Array<{ cls: string; args: unknown[] }> = [];

vi.mock('@mcp/code-agent/providers/gemini.js', () => ({
  GeminiChatProvider: vi.fn().mockImplementation(function (...args: unknown[]) {
    chatCalls.push({ cls: 'GeminiChatProvider', args });
  }),
}));
vi.mock('@mcp/indexer/indexer/providers/gemini.js', () => ({
  GeminiProvider: vi.fn().mockImplementation(function (...args: unknown[]) {
    idxCalls.push({ cls: 'GeminiProvider', args });
  }),
}));

import { gemini } from '@mcp/services/providers/definitions/gemini.js';
import { buildGemini } from '../wires/gemini.js';
import { geminiSpec } from '../specs/gemini.js';

/** Trailing `undefined` args == not passing them (optional ctor params). */
function stripTrailingUndefined(args: unknown[]): unknown[] {
  const out = [...args];
  while (out.length > 0 && out[out.length - 1] === undefined) out.pop();
  return out;
}

/**
 * Mirror `buildProviderDefinition` (the dispatcher) for the gemini wire. The
 * dispatcher isn't wired for 'gemini' yet (registered separately), so we
 * assemble the engine definition here exactly the way it does: metadata
 * straight-through + the wire builder's adapter functions.
 */
function engineDefinition(spec: ProviderSpec): ProviderDefinition {
  return {
    kind: spec.kind,
    displayName: spec.displayName,
    credKind: spec.credKind,
    envVars: spec.envVars,
    defaultBaseURL: spec.defaultBaseURL,
    defaultModels: spec.defaultModels,
    defaultModel: spec.defaultModel,
    pricing: spec.pricing,
    capabilities: spec.capabilities,
    visual: spec.visual,
    auth: spec.auth,
    ...buildGemini(spec),
  };
}

const CREDS: ResolvedCreds = { apiKey: 'k' };

describe('gemini equivalence: engine(spec) == definition', () => {
  beforeEach(() => {
    chatCalls.length = 0;
    idxCalls.length = 0;
  });

  it('metadata matches', () => {
    const built = engineDefinition(geminiSpec);
    expect(built.kind).toBe(gemini.kind);
    expect(built.displayName).toBe(gemini.displayName);
    expect(built.credKind).toBe(gemini.credKind);
    expect(built.envVars).toEqual(gemini.envVars);
    expect(built.defaultBaseURL).toBe(gemini.defaultBaseURL);
    expect(built.defaultModels).toEqual(gemini.defaultModels);
    expect(built.defaultModel).toBe(gemini.defaultModel);
    expect(built.pricing).toEqual(gemini.pricing);
    expect(built.capabilities).toEqual(gemini.capabilities);
    expect(built.visual).toEqual(gemini.visual);
  });

  it('createCoder builds an identical adapter (no model → spec default)', () => {
    gemini.createCoder!(CREDS, undefined);
    const a = chatCalls[0];
    engineDefinition(geminiSpec).createCoder!(CREDS, undefined);
    const b = chatCalls[1];
    expect(b.cls).toBe(a.cls);
    expect(b.args).toEqual(a.args);
    // Both should pass the spec's defaultModel as the resolved coder model.
    expect((b.args[0] as { model?: string }).model).toBe('gemini-2.5-flash');
  });

  it('createCoder builds an identical adapter (explicit model)', () => {
    gemini.createCoder!(CREDS, 'gemini-2.5-pro');
    const a = chatCalls[0];
    engineDefinition(geminiSpec).createCoder!(CREDS, 'gemini-2.5-pro');
    const b = chatCalls[1];
    expect(b.args).toEqual(a.args);
    expect((b.args[0] as { model?: string }).model).toBe('gemini-2.5-pro');
  });

  it('createIndexer builds an identical adapter (positional apiKey, model)', () => {
    gemini.createIndexer!(CREDS, undefined);
    const a = idxCalls[0];
    engineDefinition(geminiSpec).createIndexer!(CREDS, undefined);
    const b = idxCalls[1];
    expect(b.cls).toBe(a.cls);
    expect(stripTrailingUndefined(b.args)).toEqual(stripTrailingUndefined(a.args));
  });

  it('createIndexer passes the explicit model through positionally', () => {
    gemini.createIndexer!(CREDS, 'gemini-2.5-pro');
    const a = idxCalls[0];
    engineDefinition(geminiSpec).createIndexer!(CREDS, 'gemini-2.5-pro');
    const b = idxCalls[1];
    expect(b.args).toEqual(a.args);
    expect(b.args).toEqual(['k', 'gemini-2.5-pro']);
  });
});
