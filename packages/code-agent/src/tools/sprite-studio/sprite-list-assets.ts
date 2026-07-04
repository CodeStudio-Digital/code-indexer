/**
 * Tool: `sprite_list_assets`. Read-only listing of the sprite assets in the
 * project, optionally filtered by category or a slug/name query. Lets the agent
 * discover what already exists (to iterate on) before creating a new asset.
 */
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { getGlobalSpriteStudioHost } from '@mcp/code-agent/tools/sprite-studio/bridge.js';
import { NOT_CONFIGURED } from '@mcp/code-agent/tools/sprite-studio/shared.js';

const PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    category: {
      type: 'string',
      description: 'Filter to one category (character, enemy, prop, item, tile, ...).',
    },
    q: {
      type: 'string',
      description: 'Case-insensitive substring match on the asset slug or display name.',
    },
  },
};

export function spriteListAssets(projectId: number): CoderTool {
  return {
    name: 'sprite_list_assets',
    description:
      'List the sprite assets in this project (id, slug, name, category, status, ' +
      'version count). Optionally filter by `category` or a `q` slug/name query. ' +
      'Use it to find an existing asset to iterate on before making a new one.',
    parameters: PARAMETERS,
    source: 'native',
    handler: async (args) => {
      const host = getGlobalSpriteStudioHost();
      if (!host) return err(NOT_CONFIGURED);
      try {
        const category = typeof args.category === 'string' ? args.category : undefined;
        const q = typeof args.q === 'string' ? args.q : undefined;
        const assets = await host.listAssets(projectId, { category, q });
        if (assets.length === 0) return ok('No sprite assets yet.');
        const lines = assets.map(
          (a) =>
            `#${a.id} ${a.slug} — "${a.name}" [${a.category}] ${a.status} (${a.versionCount} versions)`,
        );
        return ok(`${assets.length} assets:\n${lines.join('\n')}`);
      } catch (e) {
        return err(`sprite_list_assets failed: ${(e as Error).message}`);
      }
    },
  };
}
