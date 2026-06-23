import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ResolvedCreds } from '@mcp/provider-sdk';

const coderCalls: Array<Record<string, unknown>> = [];
const idxCalls: Array<Record<string, unknown>> = [];
let storeRows: Array<Record<string, unknown>> | null = null;

vi.mock('@mcp/code-agent/providers/chatgpt.js', () => ({
  ChatGPTCodexProvider: vi.fn().mockImplementation(function (opts: Record<string, unknown>) {
    coderCalls.push(opts);
  }),
}));
vi.mock('@mcp/indexer/indexer/providers/chatgpt.js', () => ({
  ChatGPTProvider: vi.fn().mockImplementation(function (opts: Record<string, unknown>) {
    idxCalls.push(opts);
  }),
}));
// Break the store→seed→registry module cycle and control the reasoning lookup.
vi.mock('@mcp/services/providers/shared/store.js', () => ({
  getStore: () => (storeRows == null ? null : { listModels: () => storeRows }),
}));

import { chatgpt } from '@mcp/services/providers/definitions/chatgpt.js';
import { buildProviderDefinition } from '../build-definition.js';
import { chatgptSpec } from '../specs/chatgpt.js';

const ENV_KEYS = ['CODEX_IMAGE_GEN_ENABLED', 'CODEX_IMAGE_GEN_MODELS'];
const savedEnv: Record<string, string | undefined> = {};

describe('codex (chatgpt) equivalence: engine(spec) == definition', () => {
  beforeEach(() => {
    coderCalls.length = 0;
    idxCalls.length = 0;
    storeRows = null;
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k]!;
    }
  });

  it('metadata matches', () => {
    const built = buildProviderDefinition(chatgptSpec);
    expect(built.kind).toBe(chatgpt.kind);
    expect(built.displayName).toBe(chatgpt.displayName);
    expect(built.credKind).toBe('oauth');
    expect(built.defaultModels).toEqual(chatgpt.defaultModels);
    expect(built.pricing).toEqual(chatgpt.pricing);
    expect(built.visual).toEqual(chatgpt.visual);
  });

  it('createCoder without store: model fallback + null reasoning identical', () => {
    const creds: ResolvedCreds = { apiKey: 'tok', extra: { accountId: 'acct-1' } };
    chatgpt.createCoder!(creds, undefined, { providerId: '7' });
    const a = coderCalls[0];
    buildProviderDefinition(chatgptSpec).createCoder!(creds, undefined, { providerId: '7' });
    const b = coderCalls[1];
    expect(b).toEqual(a);
    expect(b.model).toBe('gpt-5.3-codex');
    expect(b.accountId).toBe('acct-1');
    expect(b.reasoning).toBeUndefined();
    expect(b.applyPatchToolType).toBeNull();
  });

  it('createCoder with a matching provider_models row: reasoning + applyPatch flow', () => {
    storeRows = [
      {
        model_id: 'gpt-5-codex',
        supported_reasoning_levels: ['low', 'high'],
        default_reasoning_level: 'high',
        apply_patch_tool_type: 'freeform',
      },
    ];
    const creds: ResolvedCreds = { apiKey: 'tok', baseURL: 'https://proxy/codex', extra: { accountId: null } };
    chatgpt.createCoder!(creds, 'gpt-5-codex', { providerId: '3' });
    const a = coderCalls[0];
    buildProviderDefinition(chatgptSpec).createCoder!(creds, 'gpt-5-codex', { providerId: '3' });
    const b = coderCalls[1];
    expect(b).toEqual(a);
    expect(b.reasoning).toEqual({ supportedLevels: ['low', 'high'], defaultLevel: 'high' });
    expect(b.applyPatchToolType).toBe('freeform');
    expect(b.baseURL).toBe('https://proxy/codex');
  });

  it('image-generation gating (env) identical', () => {
    process.env.CODEX_IMAGE_GEN_ENABLED = '1';
    process.env.CODEX_IMAGE_GEN_MODELS = 'gpt-5-codex';
    const creds: ResolvedCreds = { apiKey: 'tok' };
    chatgpt.createCoder!(creds, 'gpt-5-codex', { providerId: '1' });
    const a = coderCalls[0];
    buildProviderDefinition(chatgptSpec).createCoder!(creds, 'gpt-5-codex', { providerId: '1' });
    const b = coderCalls[1];
    expect(b).toEqual(a);
    expect(b.imageGenerationEnabled).toBe(true);
  });

  it('createIndexer builds an identical adapter', () => {
    const creds: ResolvedCreds = { apiKey: 'tok', extra: { accountId: 'acct-9' } };
    chatgpt.createIndexer!(creds, 'gpt-4o');
    const a = idxCalls[0];
    buildProviderDefinition(chatgptSpec).createIndexer!(creds, 'gpt-4o');
    const b = idxCalls[1];
    expect(b).toEqual(a);
    expect(b.accountId).toBe('acct-9');
    expect(b.baseURL).toBe('https://chatgpt.com/backend-api/codex');
  });
});
