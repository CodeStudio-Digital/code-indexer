/**
 * Sprite Studio — project lifecycle routes.
 *
 *   GET  /api/sprite-studio/projects/:projectId            get-or-probe
 *   POST /api/sprite-studio/projects/:projectId/init       create .sprite-studio/ + row
 *   PUT  /api/sprite-studio/projects/:projectId/settings   update style/settings
 *   POST /api/sprite-studio/projects/:projectId/resync     rebuild mirror from repo
 *
 * Repo files are the product source of truth; the session bundle is the
 * operational authority.
 */
import type { Hono } from 'hono';
import { initProjectManifest, readProjectManifest, writeProjectManifest } from '@mcp/sprite-studio/repo/manifest.js';
import { DEFAULT_SPRITE_STYLE, type SpriteStyleConfig } from '@mcp/store/sprite-studio/types.js';
import type { ServerDeps } from '../../deps.js';
import type { SpriteProjectFileRow } from '../../operational-session-files.js';
import { studioSettingsToStyle } from './settings-map.js';

function projectRoot(deps: ServerDeps, ideProjectId: number): string | null {
  const project = deps.db.getProject(ideProjectId);
  return project?.root_path ?? null;
}

export function mountSpriteProjectRoutes(app: Hono, deps: ServerDeps): void {
  const store = deps.operationalSessionFiles;

  const toProjectInfo = (row: SpriteProjectFileRow): Record<string, unknown> => ({
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    settings:
      Object.keys(row.settings).length > 0
        ? row.settings
        : row.style,
    styleVersion: 1,
    exportDir: row.export_dir,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  // GET — returns { initialized, project }. Not initialized until /init ran.
  app.get('/api/sprite-studio/projects/:projectId', async (c) => {
    const ideProjectId = Number(c.req.param('projectId'));
    if (!Number.isFinite(ideProjectId)) return c.json({ error: 'invalid_project' }, 400);
    const row = await store.getSpriteProject(ideProjectId);
    if (!row) return c.json({ initialized: false, project: null });
    return c.json({ initialized: true, project: toProjectInfo(row) });
  });

  // POST /init — idempotent: writes the repo manifest + filesystem bundle.
  app.post('/api/sprite-studio/projects/:projectId/init', async (c) => {
    const ideProjectId = Number(c.req.param('projectId'));
    const root = projectRoot(deps, ideProjectId);
    if (!root) return c.json({ error: 'no_workspace' }, 400);
    let row = await store.getSpriteProject(ideProjectId);
    if (!row) {
      const project = deps.db.getProject(ideProjectId);
      row = await store.createSpriteProject({
        project_id: ideProjectId,
        name: project?.name ?? 'Sprites',
        style: DEFAULT_SPRITE_STYLE as unknown as Record<string, unknown>,
      });
    }
    initProjectManifest(root, row.name, row.style as unknown as SpriteStyleConfig);
    return c.json(toProjectInfo(row));
  });

  // PUT /settings — stores raw UI settings + derived style contract.
  app.put('/api/sprite-studio/projects/:projectId/settings', async (c) => {
    const ideProjectId = Number(c.req.param('projectId'));
    const row = await store.getSpriteProject(ideProjectId);
    if (!row) return c.json({ error: 'not_initialized' }, 404);
    const settings = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!settings) return c.json({ error: 'invalid_body' }, 400);
    const style = studioSettingsToStyle(settings);
    const updated = await store.updateSpriteProject(ideProjectId, {
      style: style as unknown as Record<string, unknown>,
      settings,
    });
    // Mirror the style into the repo manifest so the source of truth stays current.
    const root = projectRoot(deps, ideProjectId);
    if (root) {
      const manifest = readProjectManifest(root);
      if (manifest) writeProjectManifest(root, { ...manifest, style });
    }
    return c.json(toProjectInfo(updated!));
  });

  // POST /resync — the repo manifest wins over the bundle projection.
  app.post('/api/sprite-studio/projects/:projectId/resync', async (c) => {
    const ideProjectId = Number(c.req.param('projectId'));
    const root = projectRoot(deps, ideProjectId);
    if (!root) return c.json({ error: 'no_workspace' }, 400);
    const row = await store.getSpriteProject(ideProjectId);
    if (!row) return c.json({ error: 'not_initialized' }, 404);
    const manifest = readProjectManifest(root);
    if (!manifest) return c.json({ error: 'manifest_missing' }, 404);
    await store.updateSpriteProject(ideProjectId, {
      name: manifest.name,
      style: manifest.style as unknown as Record<string, unknown>,
    });
    return c.json({ ok: true });
  });

  // Bundle deletion is recoverable: it moves the entire Sprite session to the
  // same-volume trash. Product files in `.sprite-studio` remain user-owned.
  app.delete('/api/sprite-studio/projects/:projectId', async (c) => {
    const ideProjectId = Number(c.req.param('projectId'));
    if (!Number.isFinite(ideProjectId)) {
      return c.json({ error: 'invalid_project' }, 400);
    }
    const deleted = await store.deleteSpriteProject(ideProjectId);
    return deleted
      ? c.json({ ok: true })
      : c.json({ error: 'not_initialized' }, 404);
  });
}
