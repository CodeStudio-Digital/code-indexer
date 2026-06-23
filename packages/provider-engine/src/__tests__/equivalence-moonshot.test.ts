import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ResolvedCreds } from '@mcp/provider-sdk';

const chatCalls: Array<Record<string, unknown>> = [];
const idxCalls: Array<unknown[]> = [];

vi.mock('@mcp/code-agent/providers/kimi-code.js', () => ({
  KimiCodeChatProvider: vi.fn().mockImplementation(function (opts: Record<string, unknown>) {
    chatCalls.push(opts);
  }),
}));
vi.mock('@mcp/indexer/indexer/providers/kimi-code.js', () => ({
  KimiCodeProvider: vi.fn().mockImplementation(function (...args: unknown[]) {
    idxCalls.push(args);
  }),
}));

import { moonshot } from '@mcp/services/providers/definitions/moonshot.js';
import { buildProviderDefinition } from '../build-definition.js';
import { moonshotSpec } from '../specs/moonshot.js';

function stripTrailingUndefined(args: unknown[]): unknown[] {
  const out = [...args];
  while (out.length > 0 && out[out.length - 1] === undefined) out.pop();
  return out;
}

describe('moonshot equivalence (kimi wire): engine(spec) == definition', () => {
  beforeEach(() => {
    chatCalls.length = 0;
    idxCalls.length = 0;
  });

  it('metadata matches', () => {
    const built = buildProviderDefinition(moonshotSpec);
    expect(built.kind).toBe(moonshot.kind);
    expect(built.displayName).toBe(moonshot.displayName);
    expect(built.credKind).toBe(moonshot.credKind);
    expect(built.envVars).toEqual(moonshot.envVars);
    expect(built.defaultBaseURL).toBe(moonshot.defaultBaseURL);
    expect(built.defaultModels).toEqual(moonshot.defaultModels);
    expect(built.defaultModel).toBe(moonshot.defaultModel);
    expect(built.pricing).toEqual(moonshot.pricing);
    expect(built.capabilities).toEqual(moonshot.capabilities);
    expect(built.visual).toEqual(moonshot.visual);
  });

  it('createCoder: thinkingMode from extra.kimi_code_thinking_mode flows identically', () => {
    const creds: ResolvedCreds = { apiKey: 'k', extra: { kimi_code_thinking_mode: 'enabled' } };
    moonshot.createCoder!(creds, undefined);
    const a = chatCalls[0];
    buildProviderDefinition(moonshotSpec).createCoder!(creds, undefined);
    const b = chatCalls[1];
    expect(b).toEqual(a);
    expect(b.thinkingMode).toBe('enabled');
    expect(b.model).toBe('kimi-k2-0711-preview');
    expect(b.baseURL).toBe('https://api.moonshot.ai/v1');
  });

  it('createCoder: illegal thinking mode falls back to auto (both)', () => {
    const creds: ResolvedCreds = { apiKey: 'k', extra: { kimi_code_thinking_mode: 'nonsense' } };
    moonshot.createCoder!(creds, undefined);
    const a = chatCalls[0];
    buildProviderDefinition(moonshotSpec).createCoder!(creds, undefined);
    const b = chatCalls[1];
    expect(b).toEqual(a);
    expect(b.thinkingMode).toBe('auto');
  });

  it('createIndexer builds an identical adapter', () => {
    const creds: ResolvedCreds = { apiKey: 'k', baseURL: 'https://api.moonshot.cn/v1' };
    moonshot.createIndexer!(creds, undefined);
    const a = idxCalls[0];
    buildProviderDefinition(moonshotSpec).createIndexer!(creds, undefined);
    const b = idxCalls[1];
    expect(stripTrailingUndefined(b)).toEqual(stripTrailingUndefined(a));
  });
});
