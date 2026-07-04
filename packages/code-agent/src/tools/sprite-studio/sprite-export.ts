/**
 * Tool: `sprite_export`. Export approved sprite assets to the project's export
 * dir (a spritesheet + atlas JSON, individual PNGs, or a Phaser atlas). The
 * host writes the files into `<repo>/<export_dir>/` and returns the written
 * paths so the agent can reference them.
 */
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { getGlobalSpriteStudioHost } from '@mcp/code-agent/tools/sprite-studio/bridge.js';
import { NOT_CONFIGURED } from '@mcp/code-agent/tools/sprite-studio/shared.js';

const PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    format: {
      type: 'string',
      description: 'Export format.',
      enum: ['png-individual', 'spritesheet-json', 'phaser'],
    },
    asset_slugs: {
      type: 'array',
      description: 'Slugs of the assets to export. Omit to export all approved assets.',
      items: { type: 'string' },
    },
  },
  required: ['format'],
};

export function spriteExport(projectId: number): CoderTool {
  return {
    name: 'sprite_export',
    description:
      "Export sprite assets to the project's export directory as individual PNGs, a " +
      'generic spritesheet + JSON atlas, or a Phaser atlas. Pass `format` and, ' +
      'optionally, `asset_slugs` (defaults to all approved assets).',
    parameters: PARAMETERS,
    source: 'native',
    mutates: true,
    riskLevel: 'write',
    timeoutMs: 120_000,
    handler: async (args) => {
      const host = getGlobalSpriteStudioHost();
      if (!host) return err(NOT_CONFIGURED);
      const format = typeof args.format === 'string' ? args.format : '';
      if (!format) return err('sprite_export: `format` is required.');
      const assetSlugs = Array.isArray(args.asset_slugs)
        ? (args.asset_slugs as unknown[]).filter((s): s is string => typeof s === 'string')
        : undefined;
      try {
        const { files } = await host.export({ projectId, format, assetSlugs });
        if (files.length === 0) return ok('Export produced no files (no approved assets?).');
        return ok(`Exported ${files.length} file(s):\n${files.join('\n')}`);
      } catch (e) {
        return err(`sprite_export failed: ${(e as Error).message}`);
      }
    },
  };
}
