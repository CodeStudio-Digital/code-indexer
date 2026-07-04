/**
 * Sprite Studio routes — mounted from server.ts, gated by
 * `config.features.spriteStudioEnabled`. Repo files under `.sprite-studio/`
 * are the source of truth; the DB is the operational mirror + job ledger.
 */
import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { mountSpriteProjectRoutes } from './projects.routes.js';
import { mountSpriteAssetRoutes } from './assets.routes.js';
import { mountSpriteVersionCurationRoutes } from './versions-curation.routes.js';
import { mountSpriteImportSheetRoutes } from './import-sheet.routes.js';
import { mountSpriteSheetRoutes } from './sheet.routes.js';
import { mountSpriteAnimationRoutes } from './animations.routes.js';
import { mountSpriteTrackRoutes } from './tracks.routes.js';
import { mountSpriteGifRoutes } from './gif.routes.js';
import { mountSpriteFrameAlignRoutes } from './frames-align.routes.js';
import { mountSpriteGenerateRoutes } from './generate.routes.js';
import { mountSpriteExportRoutes } from './export.routes.js';
import { mountSpriteStreamRoutes } from './stream.routes.js';
import { mountSpriteModelRoutes } from './models.routes.js';
import { mountSpriteProjectFileRoutes } from './project-files.routes.js';
import { startSpriteBusSweep } from './bus-registry.js';

export function mountSpriteStudioRoutes(app: Hono, deps: ServerDeps): void {
  mountSpriteProjectRoutes(app, deps);
  mountSpriteAssetRoutes(app, deps);
  mountSpriteVersionCurationRoutes(app, deps);
  mountSpriteImportSheetRoutes(app, deps);
  mountSpriteSheetRoutes(app, deps);
  mountSpriteAnimationRoutes(app, deps);
  mountSpriteTrackRoutes(app, deps);
  mountSpriteGifRoutes(app, deps);
  mountSpriteFrameAlignRoutes(app, deps);
  mountSpriteGenerateRoutes(app, deps);
  mountSpriteExportRoutes(app, deps);
  mountSpriteStreamRoutes(app, deps);
  mountSpriteModelRoutes(app, deps);
  mountSpriteProjectFileRoutes(app, deps);
  startSpriteBusSweep();
}
