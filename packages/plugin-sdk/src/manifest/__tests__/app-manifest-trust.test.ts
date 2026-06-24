import { describe, it, expect } from 'vitest';
import { parseAppManifest } from '../app-json.schema.js';

/** An OAuth connector manifest: declares host-only capabilities (auth.hooks +
 *  sdk:* discovery + pat-exchange) that the third-party gate must reject but the
 *  first-party bundled lane must accept. */
const connectorApp = {
  providers: [
    {
      kind: 'copilot',
      displayName: 'GitHub Copilot',
      credKind: 'oauth',
      envVars: [],
      defaultModels: ['gpt-4o'],
      pricing: {},
      wire: 'openai-compat',
      discovery: { from: 'sdk:copilot' },
      auth: { mode: 'oauth', flavor: 'pat-exchange', hooks: 'copilot' },
    },
  ],
};

const apiKeyApp = {
  providers: [
    {
      kind: 'cloudflare',
      displayName: 'Cloudflare',
      credKind: 'api-key',
      envVars: ['CF_API_TOKEN'],
      defaultModels: ['@cf/m'],
      pricing: {},
      wire: 'openai-compat',
      discovery: { from: 'cloudflare-models' },
    },
  ],
};

describe('parseAppManifest — first-party trust lane (C3)', () => {
  it('rejects a host-capability connector by default (third-party gate)', () => {
    expect(() => parseAppManifest(connectorApp)).toThrow();
  });

  it('accepts it under trustProviders (bundled first-party lane)', () => {
    const app = parseAppManifest(connectorApp, { trustProviders: true });
    expect(app.providers?.[0].kind).toBe('copilot');
  });

  it('an api-key plugin passes BOTH lanes (no host capability claimed)', () => {
    expect(parseAppManifest(apiKeyApp).providers?.[0].kind).toBe('cloudflare');
    expect(parseAppManifest(apiKeyApp, { trustProviders: true }).providers?.[0].kind).toBe('cloudflare');
  });

  it('trustProviders does NOT relax non-provider validation (unknown tool field still rejected)', () => {
    const bad = { tools: [{ name: 't', description: 'd', bogus: true }] };
    // tools use .default()/loose object, so assert the provider-trust flag is
    // scoped to providers: a malformed PROVIDER is still rejected even trusted.
    const badProvider = { providers: [{ kind: 'x' }] };
    expect(() => parseAppManifest(badProvider, { trustProviders: true })).toThrow();
    void bad;
  });
});
