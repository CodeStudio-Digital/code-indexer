/**
 * Tool: `sprite_generate` (the workhorse). Generates a sprite from a text
 * intent, in the project's style, and AUTO-SAVES it as a new immutable version
 * of the target asset (created on the fly when only a name is given). Runs the
 * full generation job — prompt-expand → provider → post-process (downscale /
 * quantize / outline) → save — and blocks until it lands a version, surfacing
 * progress via `ctx.reportProgress` when the runner wired it.
 */
import type { CoderTool, JsonSchema, ToolContext } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { getGlobalSpriteStudioHost } from '@mcp/code-agent/tools/sprite-studio/bridge.js';
import { NOT_CONFIGURED } from '@mcp/code-agent/tools/sprite-studio/shared.js';

const PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    intent: {
      type: 'string',
      description:
        'What to draw, in plain words ("a goblin chef holding a ladle"). The style ' +
        'contract (canvas, palette, perspective) is applied automatically — describe ' +
        'the SUBJECT, not the pixel-art style.',
    },
    asset_name: {
      type: 'string',
      description:
        'Display name of the asset to create or update. Provide this when starting a ' +
        'new asset. Ignored when `asset_id` is given.',
    },
    asset_id: {
      type: 'string',
      description: 'Id of an existing asset to add a new version to (from sprite_list_assets).',
    },
    category: {
      type: 'string',
      description: 'Category for a newly created asset (character, enemy, prop, ...). Default misc.',
    },
  },
  required: ['intent'],
};

export function spriteGenerate(projectId: number): CoderTool {
  return {
    name: 'sprite_generate',
    description:
      'Generate a sprite from a text intent in the project style and save it as a new ' +
      'version of an asset (created from `asset_name` when new, or targeted by ' +
      '`asset_id`). Blocks until the sprite is generated, post-processed and saved into ' +
      'the game repo. Provide `asset_name` for a new asset or `asset_id` to iterate.',
    parameters: PARAMETERS,
    source: 'native',
    mutates: true,
    riskLevel: 'write',
    // Generation is a multi-minute provider round-trip + post-process.
    timeoutMs: 180_000,
    handler: async (args, ctx: ToolContext) => {
      const host = getGlobalSpriteStudioHost();
      if (!host) return err(NOT_CONFIGURED);

      const intent = typeof args.intent === 'string' ? args.intent.trim() : '';
      if (!intent) return err('sprite_generate: `intent` is required.');
      const assetId = typeof args.asset_id === 'string' && args.asset_id.trim()
        ? args.asset_id.trim()
        : undefined;
      const assetName = typeof args.asset_name === 'string' ? args.asset_name.trim() : undefined;
      if (assetId === undefined && !assetName) {
        return err('sprite_generate: provide `asset_name` (new asset) or `asset_id` (existing).');
      }
      const category = typeof args.category === 'string' ? args.category : undefined;

      try {
        ctx.reportProgress?.(`Generating sprite: ${intent.slice(0, 60)}`);
        const result = await host.generate({
          projectId,
          intent,
          assetId,
          assetName,
          category,
          n: 1,
          autoSave: true,
        });
        ctx.reportProgress?.(`Saved ${result.slug} v${result.versionId}`);
        const lines = [
          `Generated and saved a new version of "${result.slug}".`,
          `asset_id: ${result.assetId}`,
          `version_id: ${result.versionId}`,
          `size: ${result.width}x${result.height}`,
          `file: .sprite-studio/${result.fileRelPath}`,
        ];
        return ok(lines.join('\n'));
      } catch (e) {
        return err(`sprite_generate failed: ${(e as Error).message}`);
      }
    },
  };
}
