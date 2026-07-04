/**
 * Tool: `sprite_get_project`. Read-only overview of the Sprite Studio project
 * bound to the current IDE project: whether the studio is initialized, how many
 * assets it has, and the style contract used by every generation. The agent
 * calls this first to know the canvas size, palette and perspective it must
 * describe intents against.
 */
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { getGlobalSpriteStudioHost } from '@mcp/code-agent/tools/sprite-studio/bridge.js';
import { NOT_CONFIGURED } from '@mcp/code-agent/tools/sprite-studio/shared.js';

const PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {},
};

export function spriteGetProject(projectId: number): CoderTool {
  return {
    name: 'sprite_get_project',
    description:
      'Read the Sprite Studio project overview: whether the studio is initialized, ' +
      'the asset count, and the style contract (canvas size, palette, perspective, ' +
      'outline) that every generated sprite must follow. Call this before generating.',
    parameters: PARAMETERS,
    source: 'native',
    handler: async () => {
      const host = getGlobalSpriteStudioHost();
      if (!host) return err(NOT_CONFIGURED);
      try {
        const project = await host.getProject(projectId);
        if (!project || !project.initialized) {
          return ok(
            'Sprite Studio is not initialized for this project. Open the Sprites view ' +
              'and initialize the studio (creates `.sprite-studio/`) before generating.',
          );
        }
        const lines = [
          `initialized: true`,
          `assets: ${project.assetCount}`,
          `style: ${JSON.stringify(project.style)}`,
        ];
        return ok(lines.join('\n'));
      } catch (e) {
        return err(`sprite_get_project failed: ${(e as Error).message}`);
      }
    },
  };
}
