/**
 * Sprite Studio host bridge — the process-singleton the `sprite_*` agent tools
 * call, mirroring `setGlobalVisionDescriber` (core/vision-describer.ts) and
 * `setGlobalPreviewDevtools` (tools/preview/bridge.ts).
 *
 * The REAL implementation lives MAIN-SIDE in the http-api process
 * (`server/sprite-studio-host-impl.ts`): it resolves the sprite-project row,
 * gets-or-creates the asset in the game repo, enqueues + runs a generation job
 * and reads back the created version. In the coder WORKER a shim is installed
 * that forwards each method over the worker→host MessageBridge
 * (`spriteStudioHost` channel). In headless / unconfigured runs nothing is
 * wired → the tools return a clear "configure Sprite Studio" message.
 *
 * This module intentionally imports NOTHING from `@mcp/sprite-studio` — the
 * types below are the narrow wire contract, kept local so code-agent stays free
 * of the package (identical posture to vision-describer).
 */

/** Agent-triggered generate: intent + target asset (by id or name). */
export interface SpriteGenerateToolInput {
  /** IDE project id (not the sprite-project row id). */
  projectId: number;
  /** Existing/new asset display name (created when `assetId` is absent). */
  assetName?: string;
  /** Target an existing asset directly (skips name lookup/create). */
  assetId?: string;
  /** What to draw ("a goblin chef with a ladle"). */
  intent: string;
  /** Asset category for a freshly created asset (default 'misc'). */
  category?: string;
  /** Candidate count; the agent path auto-saves candidate 0 (n forced to 1). */
  n?: number;
  /** Reserved — the agent path always auto-saves. */
  autoSave?: boolean;
}

/** The version created by an auto-saved generate. */
export interface SpriteGenerateToolResult {
  assetId: string;
  slug: string;
  versionId: string;
  /** Path of the PNG relative to `.sprite-studio/` (e.g. `assets/goblin/v001.png`). */
  fileRelPath: string;
  width: number;
  height: number;
}

export interface ISpriteStudioHost {
  /** Project overview, or null when the IDE project has no sprite project. */
  getProject(
    projectId: number,
  ): Promise<{ initialized: boolean; assetCount: number; style: unknown } | null>;
  /** List assets, optionally filtered by category and/or a slug/name query. */
  listAssets(
    projectId: number,
    filter?: { category?: string; q?: string },
  ): Promise<
    Array<{
      id: string;
      slug: string;
      name: string;
      category: string;
      status: string;
      versionCount: number;
    }>
  >;
  /** Enqueue an autoSave generation job, wait for terminal, return the version. */
  generate(input: SpriteGenerateToolInput): Promise<SpriteGenerateToolResult>;
  /** Apply deterministic ops to an asset's current version → a new version. */
  process(input: {
    projectId: number;
    assetId: string;
    ops: unknown[];
  }): Promise<{ versionId: string }>;
  /** Export assets to the project's export dir; returns written file paths. */
  export(input: {
    projectId: number;
    assetSlugs?: string[];
    format: string;
  }): Promise<{ files: string[] }>;
}

/** Thrown (by message) when no Sprite Studio host is wired for this process. */
export const SPRITE_STUDIO_NOT_CONFIGURED = 'SPRITE_STUDIO_NOT_CONFIGURED';

let globalSpriteHost: ISpriteStudioHost | null = null;

/** Wire the singleton. http-api main sets the real host; the worker sets a
 *  bridge shim; headless leaves it null. Pass null to detach (tests). */
export function setGlobalSpriteStudioHost(impl: ISpriteStudioHost | null): void {
  globalSpriteHost = impl;
}

export function getGlobalSpriteStudioHost(): ISpriteStudioHost | null {
  return globalSpriteHost;
}
