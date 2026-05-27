/**
 * Integration tests for the /api/admin/capabilities/* routes (Phase G).
 *
 * Uses a real Hono instance via app.request() — no network, no DB. The
 * routes touch only the in-memory fallback tracker and pure resolution
 * helpers exported from capabilities.ts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearCapabilityFallbacksForTest,
  recordCapabilityFallback,
} from '@mcp/code-agent/providers/capabilities.js';
import { capabilitiesRouter } from '../capabilities.routes.js';

describe('GET /capabilities/fallbacks', () => {
  beforeEach(() => clearCapabilityFallbacksForTest());

  it('returns an empty list when nothing has fallen back yet', async () => {
    const app = capabilitiesRouter();
    const r = await app.request('/capabilities/fallbacks');
    expect(r.status).toBe(200);
    const body = (await r.json()) as { fallbacks: unknown[] };
    expect(body.fallbacks).toEqual([]);
  });

  it('lists every recorded fallback event, most-recent first', async () => {
    recordCapabilityFallback({ model: 'first-model', source: 'inferred', via: 'family:anthropic-opus', window: 200_000 });
    await new Promise((r) => setTimeout(r, 5));
    recordCapabilityFallback({ model: 'second-model', source: 'fallback', via: 'hardcoded:128k', window: 128_000 });

    const app = capabilitiesRouter();
    const r = await app.request('/capabilities/fallbacks');
    const body = (await r.json()) as {
      fallbacks: Array<{ model: string; source: string; via: string; window: number; count: number }>;
    };
    expect(body.fallbacks).toHaveLength(2);
    expect(body.fallbacks[0].model).toBe('second-model'); // most recent first
    expect(body.fallbacks[1].model).toBe('first-model');
    expect(body.fallbacks[0].source).toBe('fallback');
    expect(body.fallbacks[1].source).toBe('inferred');
  });
});

describe('GET /capabilities/resolve', () => {
  it('returns 400 when `model` query param is missing', async () => {
    const app = capabilitiesRouter();
    const r = await app.request('/capabilities/resolve');
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toContain('model');
  });

  it('returns the static + runtime resolution for a known registry model', async () => {
    const app = capabilitiesRouter();
    const r = await app.request('/capabilities/resolve?model=gpt-5.5');
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      model: string;
      static: { window: number; source: string; via: string };
      runtime: { window: number; isFallback: boolean; source: string };
    };
    expect(body.model).toBe('gpt-5.5');
    expect(body.static.source).toBe('registry-exact');
    expect(body.static.window).toBe(272_000);
    expect(body.runtime.isFallback).toBe(false);
  });

  it('reports inferred source for unknown variant matching family heuristic', async () => {
    const app = capabilitiesRouter();
    const r = await app.request('/capabilities/resolve?model=claude-mystery-99');
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      static: { source: string; window: number; via: string };
      runtime: { isFallback: boolean; source: string };
    };
    expect(body.static.source).toBe('inferred');
    expect(body.static.window).toBe(200_000);
    expect(body.static.via).toContain('family:anthropic');
    expect(body.runtime.source).toBe('inferred');
    expect(body.runtime.isFallback).toBe(true);
  });

  it('reports fallback source for truly unknown models', async () => {
    const app = capabilitiesRouter();
    const r = await app.request('/capabilities/resolve?model=completely-custom-zzz');
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      static: { source: string; window: number };
      runtime: { isFallback: boolean; source: string };
    };
    expect(body.static.source).toBe('fallback');
    expect(body.static.window).toBe(128_000);
    expect(body.runtime.isFallback).toBe(true);
    expect(body.runtime.source).toBe('fallback');
  });

  it('URL-decodes the model query param (handles slashes/colons)', async () => {
    const app = capabilitiesRouter();
    const encoded = encodeURIComponent('claude-opus-4-7');
    const r = await app.request(`/capabilities/resolve?model=${encoded}`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { model: string; static: { source: string } };
    expect(body.model).toBe('claude-opus-4-7');
    expect(body.static.source).toBe('registry-exact');
  });
});
