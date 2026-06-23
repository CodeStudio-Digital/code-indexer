import { describe, it, expect } from 'vitest';
import { providerSpecSchema, thirdPartyProviderSpecSchema } from '@mcp/provider-sdk';
import { BUILTIN_SPECS } from '../specs/index.js';
import { zaiSpec } from '../specs/openai-compat.js';

/**
 * Guards the declarative-loader cutover: a plugin authors a ProviderSpec as data
 * in its manifest, validated by these schemas before buildProviderDefinition.
 */
describe('ProviderSpec schema', () => {
  describe('providerSpecSchema (full / host)', () => {
    it('accepts every one of the 14 built-in specs (drift guard)', () => {
      for (const spec of BUILTIN_SPECS) {
        const r = providerSpecSchema.safeParse(spec);
        if (!r.success) {
          throw new Error(`built-in spec '${spec.kind}' failed schema: ${JSON.stringify(r.error.issues)}`);
        }
        expect(r.success).toBe(true);
      }
    });

    it('rejects an unknown top-level field (.strict)', () => {
      const r = providerSpecSchema.safeParse({ ...zaiSpec, bogusField: 1 });
      expect(r.success).toBe(false);
    });
  });

  describe('thirdPartyProviderSpecSchema (plugin)', () => {
    it('accepts a clean declarative provider (zai: openai-compat + openai-models discovery, no host-only fields)', () => {
      expect(thirdPartyProviderSpecSchema.safeParse(zaiSpec).success).toBe(true);
    });

    const reject = (label: string, patch: Record<string, unknown>) =>
      it(`rejects ${label}`, () => {
        const r = thirdPartyProviderSpecSchema.safeParse({ ...zaiSpec, ...patch });
        expect(r.success).toBe(false);
      });

    // host-only auth hook
    reject('auth.hooks (names a host exotic-hook module)', { auth: { mode: 'oauth', hooks: 'anthropic' } });
    // host-only OAuth flavor (needs a host hook)
    reject('auth.flavor=pat-exchange', { auth: { mode: 'oauth', flavor: 'pat-exchange' } });
    // host-only discovery formats (run host OAuth/SDK code)
    reject('discovery.from=sdk:claude-code', { discovery: { from: 'sdk:claude-code' } });
    reject('discovery.from=chatgpt-models', { discovery: { from: 'chatgpt-models' } });
    // host-only test formats
    reject('test.from=codex-health', { test: { from: 'codex-health' } });
    reject('test.from=sdk:kimi-code', { test: { from: 'sdk:kimi-code' } });
    // unknown wire (not one of the 6)
    reject('an unknown wire', { wire: 'totally-new-protocol' });

    it('accepts the declarative-safe subset (openai-models discovery + RFC device-code auth + api-key test)', () => {
      const ok = {
        ...zaiSpec,
        discovery: { from: 'openai-models' as const },
        test: { from: 'openai-models' as const },
        auth: { mode: 'oauth' as const, flavor: 'device-code' as const, clientId: 'x', deviceAuthUrl: 'https://e/d', tokenUrl: 'https://e/t' },
      };
      expect(thirdPartyProviderSpecSchema.safeParse(ok).success).toBe(true);
    });
  });
});
