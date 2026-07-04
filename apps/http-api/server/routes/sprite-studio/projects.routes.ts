/**
 * Sprite Studio — project lifecycle routes.
 *
 *   GET  /api/sprite-studio/projects/:projectId            get-or-probe
 *   POST /api/sprite-studio/projects/:projectId/init       create .sprite-studio/ + row
 *   PUT  /api/sprite-studio/projects/:projectId/settings   update style/settings
 *   POST /api/sprite-studio/projects/:projectId/resync     rebuild mirror from repo
 *
 * Repo files are the source of truth; the DB row is the operational mirror.
 */
import type { Hono } from 'hono';
import { initProjectManifest, readProjectManifest, writeProjectManifest } from '@mcp/sprite-studio/repo/manifest.js';
import type { ServerDeps } from '../../deps.js';
import { toProjectInfo } from './mappers.js';
import { studioSettingsToStyle } from './settings-map.js';
import { resyncSpriteProject } from './resync.js';

function projectRoot(deps: ServerDeps, ideProjectId: number): string | null {
  const project = deps.db.getProject(ideProjectId);
  return project?.root_path ?? null;
}

export function mountSpriteProjectRoutes(app: Hono, deps: ServerDeps): void {
  const store = deps.spriteProjectsStore;

  // GET — returns { initialized, project }. Not initialized until /init ran.
  app.get('/api/sprite-studio/projects/:projectId', (c) => {
    const ideProjectId = Number(c.req.param('projectId'));
    if (!Number.isFinite(ideProjectId)) return c.json({ error: 'invalid_project' }, 400);
    const row = store.getByProjectId(ideProjectId);
    if (!row) return c.json({ initialized: false, project: null });
    return c.json({ initialized: true, project: toProjectInfo(row) });
  });

  // POST /init — idempotent: writes .sprite-studio/project.json + the DB row.
  app.post('/api/sprite-studio/projects/:projectId/init', (c) => {
    const ideProjectId = Number(c.req.param('projectId'));
    const root = projectRoot(deps, ideProjectId);
    if (!root) return c.json({ error: 'no_workspace' }, 400);
    let row = store.getByProjectId(ideProjectId);
    if (!row) {
      const project = deps.db.getProject(ideProjectId);
      row = store.create({ project_id: ideProjectId, name: project?.name ?? 'Sprites' });
    }
    initProjectManifest(root, row.name, row.style);
    return c.json(toProjectInfo(row));
  });

  // PUT /settings — stores raw UI settings + derived style contract.
  app.put('/api/sprite-studio/projects/:projectId/settings', async (c) => {
    const ideProjectId = Number(c.req.param('projectId'));
    const row = store.getByProjectId(ideProjectId);
    if (!row) return c.json({ error: 'not_initialized' }, 404);
    const settings = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!settings) return c.json({ error: 'invalid_body' }, 400);
    const style = studioSettingsToStyle(settings);
    store.update(row.id, { style, settings });
    // Mirror the style into the repo manifest so the source of truth stays current.
    const root = projectRoot(deps, ideProjectId);
    if (root) {
      const manifest = readProjectManifest(root);
      if (manifest) writeProjectManifest(root, { ...manifest, style });
    }
    const updated = store.getByProjectId(ideProjectId);
    return c.json(toProjectInfo(updated!));
  });

  // POST /resync — repo manifest wins; DB rows without a file → status 'missing'.
  app.post('/api/sprite-studio/projects/:projectId/resync', (c) => {
    const ideProjectId = Number(c.req.param('projectId'));
    const root = projectRoot(deps, ideProjectId);
    if (!root) return c.json({ error: 'no_workspace' }, 400);
    const row = store.getByProjectId(ideProjectId);
    if (!row) return c.json({ error: 'not_initialized' }, 404);
    resyncSpriteProject(deps, row.id, root);
    return c.json({ ok: true });
  });
}
