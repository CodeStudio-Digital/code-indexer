/**
 * Public entry point for the Sprite Studio agent tools.
 *
 * `buildSpriteStudioTools(projectId)` is registered on a single session whose
 * IDE project has a `.sprite-studio/` directory (gated by
 * `config.features.spriteStudioEnabled` in `code-agent/src/index.ts`, mirroring
 * the DS Studio registration). Every tool reaches the real work through the
 * process singleton `getGlobalSpriteStudioHost()` — set MAIN-SIDE in the
 * http-api server, and shimmed over the MessageBridge in the coder worker
 * (exact vision-describer precedent).
 *
 * The agent-facing tools are:
 *   - sprite_get_project  — style contract + asset count (call first).
 *   - sprite_list_assets  — discover existing assets to iterate on.
 *   - sprite_generate     — text intent → post-processed sprite, auto-saved.
 *   - sprite_process      — deterministic ops → new version.
 *   - sprite_export       — write assets to the export dir.
 */
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import { spriteGetProject } from '@mcp/code-agent/tools/sprite-studio/sprite-get-project.js';
import { spriteListAssets } from '@mcp/code-agent/tools/sprite-studio/sprite-list-assets.js';
import { spriteGenerate } from '@mcp/code-agent/tools/sprite-studio/sprite-generate.js';
import { spriteProcess } from '@mcp/code-agent/tools/sprite-studio/sprite-process.js';
import { spriteExport } from '@mcp/code-agent/tools/sprite-studio/sprite-export.js';

export {
  setGlobalSpriteStudioHost,
  getGlobalSpriteStudioHost,
  SPRITE_STUDIO_NOT_CONFIGURED,
} from '@mcp/code-agent/tools/sprite-studio/bridge.js';
export type {
  ISpriteStudioHost,
  SpriteGenerateToolInput,
  SpriteGenerateToolResult,
} from '@mcp/code-agent/tools/sprite-studio/bridge.js';

export function buildSpriteStudioTools(projectId: number): CoderTool[] {
  return [
    spriteGetProject(projectId),
    spriteListAssets(projectId),
    spriteGenerate(projectId),
    spriteProcess(projectId),
    spriteExport(projectId),
  ];
}
