import { describe, expect, it } from 'vitest';
import { HttpRouter } from '@mcp/shared/http/router.js';
import type { ServerDeps } from '../../../deps.js';
import { mountCoderProvidersRoutes } from '../providers.js';

describe('coder provider capability payload', () => {
  it('exposes fixed/boolean reasoning capability without inventing effort levels', async () => {
    const app = new HttpRouter();
    mountCoderProvidersRoutes(app, {
      providerStore: {
        listProviders: () => [{
          id: 'fixed-provider',
          name: 'Fixed provider',
          kind: 'generic',
          is_default: false,
          api_key: null,
        }],
        listModels: () => [{
          model_id: 'fixed-reasoner',
          name: 'Fixed reasoner',
          mode: '',
          context_window: 128_000,
          default_max_tokens: null,
          can_reason: true,
          supported_reasoning_levels: null,
          default_reasoning_level: null,
        }],
      },
    } as unknown as ServerDeps);

    const response = await app.request('/api/coder/providers');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({
      legacy: false,
      providers: [expect.objectContaining({
        models: [expect.objectContaining({
          id: 'fixed-reasoner',
          can_reason: true,
          supported_reasoning_levels: null,
        })],
      })],
    }));
  });
});
