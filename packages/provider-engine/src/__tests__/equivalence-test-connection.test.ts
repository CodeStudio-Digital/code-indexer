import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ResolvedCreds, ProviderConfigLike } from '@mcp/provider-sdk';
import { openai } from '@mcp/services/providers/definitions/openai.js';
import { openrouter } from '@mcp/services/providers/definitions/openrouter.js';
import { anthropic } from '@mcp/services/providers/definitions/anthropic.js';
import { gemini } from '@mcp/services/providers/definitions/gemini.js';
import { bedrock } from '@mcp/services/providers/definitions/bedrock.js';
import { buildProviderDefinition } from '../build-definition.js';
import { openaiSpec, openrouterSpec, deepseekSpec, zaiSpec, cloudflareSpec } from '../specs/openai-compat.js';
import { anthropicSpec } from '../specs/anthropic.js';
import { geminiSpec } from '../specs/gemini.js';
import { bedrockSpec } from '../specs/bedrock.js';

let fetchCalls: Array<{ url: string; headers: unknown }> = [];
const origFetch = globalThis.fetch;

beforeEach(() => {
  fetchCalls = [];
  globalThis.fetch = vi.fn(async (url: unknown, init?: { headers?: unknown }) => {
    fetchCalls.push({ url: String(url), headers: init?.headers });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = origFetch;
});

const config: ProviderConfigLike = { id: 'x', kind: 'x' };

async function captureTest(
  def: { testConnection?: (ctx: { config: ProviderConfigLike; creds: ResolvedCreds }) => Promise<void> },
  creds: ResolvedCreds,
) {
  fetchCalls = [];
  await def.testConnection!({ config, creds });
  return fetchCalls.slice();
}

describe('testConnection equivalence: engine(spec) == definition', () => {
  const cases = [
    { name: 'openai', def: openai, spec: openaiSpec, creds: { apiKey: 'k' } },
    { name: 'openai (custom base)', def: openai, spec: openaiSpec, creds: { apiKey: 'k', baseURL: 'https://proxy/v1' } },
    { name: 'openrouter', def: openrouter, spec: openrouterSpec, creds: { apiKey: 'k' } },
    { name: 'anthropic', def: anthropic, spec: anthropicSpec, creds: { apiKey: 'k' } },
    { name: 'gemini', def: gemini, spec: geminiSpec, creds: { apiKey: 'k' } },
  ] as const;

  for (const { name, def, spec, creds } of cases) {
    it(`${name}: same request`, async () => {
      const a = await captureTest(def, creds);
      const b = await captureTest(buildProviderDefinition(spec), creds);
      expect(b).toEqual(a);
      expect(a.length).toBe(1); // each does exactly one probe
    });
  }

  it('bedrock: both throw the same "not implemented"', async () => {
    await expect(bedrock.testConnection!({ config, creds: {} })).rejects.toThrow('bedrock test not implemented');
    await expect(
      buildProviderDefinition(bedrockSpec).testConnection!({ config, creds: {} }),
    ).rejects.toThrow('bedrock test not implemented');
  });

  it('deepseek/zai/cloudflare have NO testConnection (no-op pass, matching the definitions)', () => {
    expect(buildProviderDefinition(deepseekSpec).testConnection).toBeUndefined();
    expect(buildProviderDefinition(zaiSpec).testConnection).toBeUndefined();
    expect(buildProviderDefinition(cloudflareSpec).testConnection).toBeUndefined();
  });
});
