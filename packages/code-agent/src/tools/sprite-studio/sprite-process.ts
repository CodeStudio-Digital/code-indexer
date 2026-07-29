/**
 * Tool: `sprite_process`. Apply deterministic image ops (background removal,
 * quantize, resize, outline, alpha cleanup, ...) to an asset's current version,
 * producing a new immutable version. The ops run off-thread in the sprite
 * worker; the tool just forwards the op list to the host.
 */
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { getGlobalSpriteStudioHost } from '@mcp/code-agent/tools/sprite-studio/bridge.js';
import { NOT_CONFIGURED } from '@mcp/code-agent/tools/sprite-studio/shared.js';

const PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    asset_id: {
      type: 'string',
      description: 'Id of the asset whose current version is the input (from sprite_list_assets).',
    },
    ops: {
      type: 'array',
      description:
        'Ordered deterministic ops, e.g. [{"op":"removeBackground","tolerance":24}, ' +
        '{"op":"quantize","maxColors":16}, {"op":"outline","color":"#000000","thickness":1}].',
      items: { type: 'object' },
    },
  },
  required: ['asset_id', 'ops'],
};

export function spriteProcess(projectId: number): CoderTool {
  return {
    name: 'sprite_process',
    description:
      "Apply deterministic image ops to an asset's current version (background " +
      'removal, quantize, resize, outline, alpha cleanup) and save the result as a ' +
      'new version. Pass `asset_id` and an ordered `ops` array.',
    parameters: PARAMETERS,
    source: 'native',
    mutates: true,
    riskLevel: 'write',
    timeoutMs: 120_000,
    handler: async (args) => {
      const host = getGlobalSpriteStudioHost();
      if (!host) return err(NOT_CONFIGURED);
      const assetId = typeof args.asset_id === 'string' && args.asset_id.trim()
        ? args.asset_id.trim()
        : undefined;
      const ops = Array.isArray(args.ops) ? (args.ops as unknown[]) : undefined;
      if (assetId === undefined) return err('sprite_process: `asset_id` is required.');
      if (!ops || ops.length === 0) return err('sprite_process: `ops` must be a non-empty array.');
      try {
        const { versionId } = await host.process({ projectId, assetId, ops });
        return ok(`Processed asset #${assetId} → new version_id ${versionId}.`);
      } catch (e) {
        return err(`sprite_process failed: ${(e as Error).message}`);
      }
    },
  };
}
