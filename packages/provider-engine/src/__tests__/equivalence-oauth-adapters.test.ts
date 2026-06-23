import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ResolvedCreds } from '@mcp/provider-sdk';

const chatCalls: Array<Record<string, unknown>> = [];
const idxCalls: Array<unknown[]> = [];

vi.mock('@mcp/code-agent/providers/openai.js', () => ({
  OpenAIChatProvider: vi.fn().mockImplementation(function (opts: Record<string, unknown>) {
    chatCalls.push({ kind: 'OpenAIChatProvider', ...opts });
  }),
}));
vi.mock('@mcp/indexer/indexer/providers/openai.js', () => ({
  OpenAIProvider: vi.fn().mockImplementation(function (...args: unknown[]) {
    idxCalls.push(['OpenAIProvider', ...args]);
  }),
}));
vi.mock('@mcp/code-agent/providers/gemini.js', () => ({
  GeminiChatProvider: vi.fn().mockImplementation(function (opts: Record<string, unknown>) {
    chatCalls.push({ kind: 'GeminiChatProvider', ...opts });
  }),
}));
vi.mock('@mcp/indexer/indexer/providers/gemini.js', () => ({
  GeminiProvider: vi.fn().mockImplementation(function (...args: unknown[]) {
    idxCalls.push(['GeminiProvider', ...args]);
  }),
}));

import { copilot } from '@mcp/services/providers/definitions/copilot.js';
import { googleOAuth } from '@mcp/services/providers/definitions/google-oauth.js';
import { buildProviderDefinition } from '../build-definition.js';
import { copilotSpec } from '../specs/copilot.js';
import { googleOAuthSpec } from '../specs/google-oauth.js';

function stripTrailingUndefined(a: unknown[]): unknown[] {
  const out = [...a];
  while (out.length > 0 && out[out.length - 1] === undefined) out.pop();
  return out;
}

describe('OAuth-credential adapter equivalence: engine(spec) == definition', () => {
  beforeEach(() => {
    chatCalls.length = 0;
    idxCalls.length = 0;
  });

  it('copilot: metadata + coder + indexer', () => {
    const built = buildProviderDefinition(copilotSpec);
    expect(built.kind).toBe(copilot.kind);
    expect(built.credKind).toBe('oauth');
    expect(built.defaultModels).toEqual(copilot.defaultModels);
    expect(built.pricing).toEqual(copilot.pricing);
    expect(built.visual).toEqual(copilot.visual);

    const creds: ResolvedCreds = {
      apiKey: 'tok',
      baseURL: 'https://api.githubcopilot.com',
      extraHeaders: { 'Editor-Version': 'x', 'Copilot-Integration-Id': 'y' },
    };
    copilot.createCoder!(creds, undefined);
    const ca = chatCalls[0];
    buildProviderDefinition(copilotSpec).createCoder!(creds, undefined);
    expect(chatCalls[1]).toEqual(ca);

    copilot.createIndexer!(creds, undefined);
    const ia = idxCalls[0];
    buildProviderDefinition(copilotSpec).createIndexer!(creds, undefined);
    expect(stripTrailingUndefined(idxCalls[1])).toEqual(stripTrailingUndefined(ia));
  });

  it('google-oauth: metadata + coder (accessToken/refresh/project/session) + indexer', () => {
    const built = buildProviderDefinition(googleOAuthSpec);
    expect(built.kind).toBe(googleOAuth.kind);
    expect(built.credKind).toBe('oauth');
    expect(built.defaultModel).toBe(googleOAuth.defaultModel); // both undefined
    expect(built.defaultModels).toEqual(googleOAuth.defaultModels);
    expect(built.pricing).toEqual(googleOAuth.pricing);
    expect(built.capabilities).toEqual(googleOAuth.capabilities);

    const creds: ResolvedCreds = {
      apiKey: 'access-tok',
      extra: { refreshToken: 'rt', projectId: 'proj-1' },
    };
    const opts = { cloudCodeSessionId: 'sess-1' };
    googleOAuth.createCoder!(creds, undefined, opts);
    const ca = chatCalls[0];
    buildProviderDefinition(googleOAuthSpec).createCoder!(creds, undefined, opts);
    expect(chatCalls[1]).toEqual(ca);
    expect(chatCalls[1].model).toBe('gemini-2.5-flash'); // the hardcoded coder fallback

    googleOAuth.createIndexer!(creds, 'gemini-2.5-pro');
    const ia = idxCalls[0];
    buildProviderDefinition(googleOAuthSpec).createIndexer!(creds, 'gemini-2.5-pro');
    expect(stripTrailingUndefined(idxCalls[1])).toEqual(stripTrailingUndefined(ia));
  });
});
