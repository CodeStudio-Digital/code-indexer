import { describe, expect, it, vi } from 'vitest';
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import {
  collectRuntimeToolTiers,
  mergeRuntimeTierSummaries,
} from '../runtime-tool-tiers.js';
import { buildExpandTools } from '../expand.js';

function tool(name: string, tier?: string): CoderTool {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    source: 'mcp_external',
    runtimeTier: tier ? { id: tier, displayName: 'plugin cloudflare' } : undefined,
    handler: async () => ({ content: '' }),
  };
}

describe('runtime tool tiers', () => {
  it('groups dynamic tools into an opt-in tier and leaves undeclared tools alone', () => {
    const catalog = collectRuntimeToolTiers([
      tool('plugin__cloudflare__deploy', 'plugin:cloudflare'),
      tool('plugin__cloudflare__logs', 'plugin:cloudflare'),
      tool('legacy_external_tool'),
    ]);

    expect([...catalog.tierMap]).toEqual([
      ['plugin__cloudflare__deploy', 'plugin:cloudflare'],
      ['plugin__cloudflare__logs', 'plugin:cloudflare'],
    ]);
    expect(catalog.summary.get('plugin:cloudflare')).toEqual({
      displayName: 'plugin cloudflare',
      toolCount: 2,
    });
  });

  it('merges plugin summaries with external MCP custom tiers', () => {
    const merged = mergeRuntimeTierSummaries(
      new Map([['cloudflare', { displayName: 'Cloudflare MCP', toolCount: 3 }]]),
      new Map([['plugin:cloudflare', { displayName: 'plugin cloudflare', toolCount: 2 }]]),
    );

    expect([...merged.keys()]).toEqual(['cloudflare', 'plugin:cloudflare']);
  });

  it('makes a plugin tier promotable through expand_toolset', async () => {
    const summary = new Map([
      ['plugin:cloudflare', { displayName: 'plugin cloudflare', toolCount: 2 }],
    ]);
    const expand = buildExpandTools(summary)[0];
    const activeTiers = new Set<string>(['bootstrap']);
    const runner = {
      activeTiers,
      promoteTier: (tier: string) => activeTiers.add(tier),
    };

    expect(expand.parameters.properties?.tier).toMatchObject({
      enum: expect.arrayContaining(['plugin:cloudflare']),
    });
    const result = await expand.handler(
      { tier: 'plugin:cloudflare' },
      { runner } as never,
    );
    expect(result.isError).toBeFalsy();
    expect(activeTiers.has('plugin:cloudflare')).toBe(true);
    expect(result.content).toContain('2 tools from plugin cloudflare');
  });

  it('reconciles a late Unity tier before rejecting an initially unknown tier', async () => {
    let unityAvailable = false;
    const beforeExpand = vi.fn(async () => { unityAvailable = true; });
    const expand = buildExpandTools(undefined, {
      beforeExpand,
      isTierAvailable: (tier) => tier === 'unity' && unityAvailable,
    })[0];
    const activeTiers = new Set<string>(['bootstrap']);

    const result = await expand.handler(
      { tier: 'unity' },
      {
        runner: {
          activeTiers,
          promoteTier: (tier: string) => activeTiers.add(tier),
        },
      } as never,
    );

    expect(beforeExpand).toHaveBeenCalledWith('unity');
    expect(result.isError).toBeFalsy();
    expect(activeTiers.has('unity')).toBe(true);
  });
});
