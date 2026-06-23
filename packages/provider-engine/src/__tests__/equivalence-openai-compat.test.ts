import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ResolvedCreds } from '@mcp/provider-sdk';

// Capture constructor args so we can assert the engine builds the SAME adapter
// the hand-written definition does. Both the definition and the engine import
// these exact specifiers, so one mock intercepts both.
const chatCalls: Array<Record<string, unknown>> = [];
const idxCalls: Array<{ cls: string; args: unknown[] }> = [];

vi.mock('@mcp/code-agent/providers/openai.js', () => ({
  OpenAIChatProvider: vi.fn().mockImplementation(function (opts: Record<string, unknown>) {
    chatCalls.push(opts);
  }),
}));
vi.mock('@mcp/indexer/indexer/providers/openai.js', () => ({
  OpenAIProvider: vi.fn().mockImplementation(function (...args: unknown[]) {
    idxCalls.push({ cls: 'OpenAIProvider', args });
  }),
}));
vi.mock('@mcp/indexer/indexer/providers/zai.js', () => ({
  ZAIProvider: vi.fn().mockImplementation(function (...args: unknown[]) {
    idxCalls.push({ cls: 'ZAIProvider', args });
  }),
}));
vi.mock('@mcp/indexer/indexer/providers/deepseek.js', () => ({
  DeepSeekProvider: vi.fn().mockImplementation(function (...args: unknown[]) {
    idxCalls.push({ cls: 'DeepSeekProvider', args });
  }),
}));

import { openai } from '@mcp/services/providers/definitions/openai.js';
import { deepseek } from '@mcp/services/providers/definitions/deepseek.js';
import { zai } from '@mcp/services/providers/definitions/zai.js';
import { cloudflare } from '@mcp/services/providers/definitions/cloudflare.js';
import { openrouter } from '@mcp/services/providers/definitions/openrouter.js';
import { buildProviderDefinition } from '../build-definition.js';
import {
  openaiSpec,
  deepseekSpec,
  zaiSpec,
  cloudflareSpec,
  openrouterSpec,
} from '../specs/openai-compat.js';

/** Trailing `undefined` args == not passing them (optional ctor params). */
function stripTrailingUndefined(args: unknown[]): unknown[] {
  const out = [...args];
  while (out.length > 0 && out[out.length - 1] === undefined) out.pop();
  return out;
}

const PAIRS = [
  { name: 'openai', def: openai, spec: openaiSpec },
  { name: 'deepseek', def: deepseek, spec: deepseekSpec },
  { name: 'zai', def: zai, spec: zaiSpec },
  { name: 'cloudflare', def: cloudflare, spec: cloudflareSpec },
  { name: 'openrouter', def: openrouter, spec: openrouterSpec },
] as const;

const CREDS: Record<string, ResolvedCreds> = {
  openai: { apiKey: 'k', baseURL: 'https://custom/v1', extra: { summary_model: 'gpt-4o-mini' } },
  deepseek: { apiKey: 'k' },
  zai: { apiKey: 'k', baseURL: 'https://admin.zai/v4' },
  cloudflare: { apiKey: 'k', extra: { account_id: 'acct-1' } },
  openrouter: { apiKey: 'k', extra: { http_referer: 'https://x', app_title: 'T' } },
};

describe('openai-compat equivalence: engine(spec) == definition', () => {
  beforeEach(() => {
    chatCalls.length = 0;
    idxCalls.length = 0;
  });

  for (const { name, def, spec } of PAIRS) {
    it(`${name}: metadata matches`, () => {
      const built = buildProviderDefinition(spec);
      expect(built.kind).toBe(def.kind);
      expect(built.displayName).toBe(def.displayName);
      expect(built.credKind).toBe(def.credKind);
      expect(built.envVars).toEqual(def.envVars);
      expect(built.defaultBaseURL).toBe(def.defaultBaseURL);
      expect(built.defaultModels).toEqual(def.defaultModels);
      expect(built.defaultModel).toBe(def.defaultModel);
      expect(built.pricing).toEqual(def.pricing);
      expect(built.capabilities).toEqual(def.capabilities);
      expect(built.visual).toEqual(def.visual);
    });

    it(`${name}: createCoder builds an identical adapter`, () => {
      const creds = CREDS[name];
      def.createCoder!(creds, undefined);
      const a = chatCalls[0];
      buildProviderDefinition(spec).createCoder!(creds, undefined);
      const b = chatCalls[1];
      expect(b).toEqual(a);
    });

    it(`${name}: createIndexer builds an identical adapter`, () => {
      const creds = CREDS[name];
      def.createIndexer!(creds, undefined);
      const a = idxCalls[0];
      buildProviderDefinition(spec).createIndexer!(creds, undefined);
      const b = idxCalls[1];
      expect(b.cls).toBe(a.cls);
      expect(stripTrailingUndefined(b.args)).toEqual(stripTrailingUndefined(a.args));
    });
  }

  it('zai: ::coding suffix routes both to the coding URL', () => {
    const creds: ResolvedCreds = { apiKey: 'k' };
    zai.createCoder!(creds, 'glm-5.1::coding');
    const a = chatCalls[0];
    buildProviderDefinition(zaiSpec).createCoder!(creds, 'glm-5.1::coding');
    const b = chatCalls[1];
    expect(b).toEqual(a);
    expect(b.baseURL).toBe('https://api.z.ai/api/coding/paas/v4/');
    expect(b.model).toBe('glm-5.1');
  });

  it('cloudflare: missing account_id throws the same actionable error (both)', () => {
    const creds: ResolvedCreds = { apiKey: 'k' };
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CF_ACCOUNT_ID;
    expect(() => cloudflare.createCoder!(creds, undefined)).toThrow(/account[_ ]id/i);
    expect(() => buildProviderDefinition(cloudflareSpec).createCoder!(creds, undefined)).toThrow(
      /account[_ ]id/i,
    );
  });
});
