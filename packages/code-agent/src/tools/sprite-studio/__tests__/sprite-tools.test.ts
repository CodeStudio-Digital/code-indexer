import { afterEach, describe, expect, it } from 'vitest';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import {
  buildSpriteStudioTools,
  setGlobalSpriteStudioHost,
  type ISpriteStudioHost,
} from '../index.js';

const CTX = { cwd: '/tmp', projectName: 'game' } as unknown as ToolContext;

afterEach(() => setGlobalSpriteStudioHost(null));

describe('buildSpriteStudioTools', () => {
  it('returns the five MVP sprite tools in order', () => {
    const tools = buildSpriteStudioTools(7);
    expect(tools.map((t) => t.name)).toEqual([
      'sprite_get_project',
      'sprite_list_assets',
      'sprite_generate',
      'sprite_process',
      'sprite_export',
    ]);
  });

  it('flags the write tools as mutating', () => {
    const byName = new Map(buildSpriteStudioTools(7).map((t) => [t.name, t]));
    for (const n of ['sprite_generate', 'sprite_process', 'sprite_export']) {
      expect(byName.get(n)?.mutates).toBe(true);
      expect(byName.get(n)?.riskLevel).toBe('write');
    }
    for (const n of ['sprite_get_project', 'sprite_list_assets']) {
      expect(byName.get(n)?.mutates).toBeUndefined();
    }
  });

  it('errors clearly when no host is wired', async () => {
    setGlobalSpriteStudioHost(null);
    const gen = buildSpriteStudioTools(7).find((t) => t.name === 'sprite_generate')!;
    const res = await gen.handler({ intent: 'a goblin', asset_name: 'Goblin' }, CTX);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('Sprite Studio is not available');
  });

  it('generate routes through the host and reports the saved version', async () => {
    const calls: unknown[] = [];
    const host: ISpriteStudioHost = {
      getProject: async () => ({ initialized: true, assetCount: 0, style: {} }),
      listAssets: async () => [],
      generate: async (input) => {
        calls.push(input);
        return { assetId: 3, slug: 'goblin', versionId: 11, fileRelPath: 'assets/goblin/v001.png', width: 32, height: 32 };
      },
      process: async () => ({ versionId: 0 }),
      export: async () => ({ files: [] }),
    };
    setGlobalSpriteStudioHost(host);
    const gen = buildSpriteStudioTools(7).find((t) => t.name === 'sprite_generate')!;
    const res = await gen.handler({ intent: 'a goblin chef', asset_name: 'Goblin' }, CTX);
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('version_id: 11');
    expect(res.content).toContain('assets/goblin/v001.png');
    expect(calls).toEqual([
      { projectId: 7, intent: 'a goblin chef', assetId: undefined, assetName: 'Goblin', category: undefined, n: 1, autoSave: true },
    ]);
  });
});
