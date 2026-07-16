import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProviderSpec, ResolvedCreds } from '@mcp/provider-sdk';
import { providerSpecSchema, thirdPartyProviderSpecSchema } from '@mcp/provider-sdk';

// Capture OpenAIChatProvider ctor opts so we can assert what the wire passes.
const chatCalls: Array<Record<string, unknown>> = [];
vi.mock('@mcp/code-agent/providers/openai.js', () => ({
  OpenAIChatProvider: vi.fn().mockImplementation(function (opts: Record<string, unknown>) {
    chatCalls.push(opts);
  }),
}));

import { buildProviderDefinition } from '../build-definition.js';
import {
  applyRequestTemplate,
  requestAuthHeader,
  requestStaticHeaders,
  rewriteModelId,
  requestQuery,
  requestFetchHeaders,
} from '../wire-helpers/request.js';

const baseSpec: ProviderSpec = {
  kind: 'custom-test',
  displayName: 'Custom Test',
  credKind: 'api-key',
  envVars: [],
  defaultModels: ['m1'],
  pricing: {},
  wire: 'openai-compat',
};

const creds: ResolvedCreds = { apiKey: 'secret-key', extra: { org: 'org-42' } };

describe('request descriptor — helpers', () => {
  const ctx = { apiKey: 'secret-key', baseURL: 'https://api.x/v1', model: 'gpt-4o', creds };

  it('applyRequestTemplate resolves the closed grammar; unknown → empty', () => {
    expect(applyRequestTemplate('Bearer {apiKey}', ctx)).toBe('Bearer secret-key');
    expect(applyRequestTemplate('{baseURL}/x', ctx)).toBe('https://api.x/v1/x');
    expect(applyRequestTemplate('m={model}', ctx)).toBe('m=gpt-4o');
    expect(applyRequestTemplate('o={extra.org}', ctx)).toBe('o=org-42');
    expect(applyRequestTemplate('u={extra.missing}', ctx)).toBe('u=');
    expect(applyRequestTemplate('z={nope}', ctx)).toBe('z=');
  });

  it('env templates read process.env', () => {
    process.env.RQ_TEST_ENV = 'envval';
    expect(applyRequestTemplate('{env.RQ_TEST_ENV}', ctx)).toBe('envval');
    delete process.env.RQ_TEST_ENV;
  });

  it('requestAuthHeader / requestStaticHeaders / query are no-ops when absent', () => {
    expect(requestAuthHeader(baseSpec, ctx)).toBeUndefined();
    expect(requestStaticHeaders(baseSpec, ctx, { A: '1' })).toEqual({ A: '1' });
    expect(requestQuery(baseSpec, ctx)).toBeUndefined();
  });

  it('rewriteModelId applies stripSuffix → map → template, identity when absent', () => {
    expect(rewriteModelId(baseSpec, 'gpt-4o')).toBe('gpt-4o');
    const spec: ProviderSpec = {
      ...baseSpec,
      request: { model: { stripSuffix: ['-latest'], map: { 'gpt-4o': 'dep-4o' }, template: 'deployments/{model}' } },
    };
    expect(rewriteModelId(spec, 'gpt-4o-latest')).toBe('deployments/dep-4o');
  });

  it('requestFetchHeaders returns native (same ref) when no request, replaces auth otherwise', () => {
    const native = { Authorization: 'Bearer secret-key' };
    expect(requestFetchHeaders(baseSpec, ctx, native, 'Authorization')).toBe(native);

    const spec: ProviderSpec = {
      ...baseSpec,
      request: { auth: { header: 'x-api-key', valueTemplate: '{apiKey}' }, headers: [{ header: 'X-Org', value: '{extra.org}' }] },
    };
    const out = requestFetchHeaders(spec, ctx, { Authorization: 'Bearer secret-key' }, 'Authorization');
    expect(out).toEqual({ 'x-api-key': 'secret-key', 'X-Org': 'org-42' });
    expect(out.Authorization).toBeUndefined();
  });
});

describe('request descriptor — openai-compat wire consumption', () => {
  beforeEach(() => {
    chatCalls.length = 0;
  });

  it('absent request → ctor opts carry NONE of the new keys (byte-identical)', () => {
    buildProviderDefinition(baseSpec).createCoder!(creds, undefined);
    const opts = chatCalls[0];
    expect(opts).toEqual({
      name: 'custom-test',
      apiKey: 'secret-key',
      baseURL: undefined,
      model: 'm1',
      defaultHeaders: undefined,
      vendor: undefined,
    });
    for (const k of ['authHeader', 'defaultQuery', 'bodyInject', 'bodyRemove', 'reasoningDeltaKey']) {
      expect(Object.prototype.hasOwnProperty.call(opts, k)).toBe(false);
    }
  });

  it('auth header override → authHeader set, apiKey suppressed to ""', () => {
    const spec: ProviderSpec = { ...baseSpec, request: { auth: { header: 'api-key', valueTemplate: '{apiKey}' } } };
    buildProviderDefinition(spec).createCoder!(creds, undefined);
    expect(chatCalls[0].authHeader).toEqual({ name: 'api-key', value: 'secret-key' });
    expect(chatCalls[0].apiKey).toBe('');
  });

  it('static/templated headers + query + model rewrite + body + response are threaded', () => {
    const spec: ProviderSpec = {
      ...baseSpec,
      request: {
        headers: [{ header: 'X-Org', value: '{extra.org}' }],
        query: { 'api-version': '2024-02-01' },
        model: { map: { m1: 'deployed-m1' } },
        body: { inject: { max_tokens: 32000 }, remove: ['temperature'] },
        response: { reasoningDeltaKey: 'thoughts' },
      },
    };
    buildProviderDefinition(spec).createCoder!(creds, undefined);
    const o = chatCalls[0];
    expect(o.defaultHeaders).toEqual({ 'X-Org': 'org-42' });
    expect(o.defaultQuery).toEqual({ 'api-version': '2024-02-01' });
    expect(o.model).toBe('deployed-m1');
    expect(o.bodyInject).toEqual({ max_tokens: 32000 });
    expect(o.bodyRemove).toEqual(['temperature']);
    expect(o.reasoningDeltaKey).toBe('thoughts');
    expect(o.apiKey).toBe('secret-key'); // no auth override → key passes through
  });
});

describe('request descriptor — schema', () => {
  it('third-party schema accepts a full request block + pricingPriority', () => {
    const spec = {
      ...baseSpec,
      pricingPriority: -10,
      request: {
        auth: { header: 'x-api-key', valueTemplate: '{apiKey}' },
        headers: [{ header: 'X-A', value: 'v' }],
        query: { q: '1' },
        model: { stripSuffix: ['-x'], map: { a: 'b' }, template: '{model}' },
        body: { inject: { max_tokens: 8, nested: { a: [1, 'x', true, null] } }, remove: ['temperature'] },
        response: { reasoningDeltaKey: 'r' },
      },
    };
    expect(thirdPartyProviderSpecSchema.safeParse(spec).success).toBe(true);
    expect(providerSpecSchema.safeParse(spec).success).toBe(true);
  });

  it('C4: request.auth requires credKind api-key (rejected for oauth)', () => {
    const spec = {
      ...baseSpec,
      credKind: 'oauth' as const,
      request: { auth: { header: 'x-api-key', valueTemplate: '{apiKey}' } },
    };
    const r = thirdPartyProviderSpecSchema.safeParse(spec);
    expect(r.success).toBe(false);
  });

  it('request.body without auth is fine for oauth (only auth is gated)', () => {
    const spec = {
      ...baseSpec,
      credKind: 'oauth' as const,
      request: { body: { inject: { max_tokens: 1 } } },
    };
    expect(thirdPartyProviderSpecSchema.safeParse(spec).success).toBe(true);
  });

  it('strict: an unknown request field is rejected', () => {
    const spec = { ...baseSpec, request: { bogus: true } };
    expect(thirdPartyProviderSpecSchema.safeParse(spec).success).toBe(false);
  });
});
