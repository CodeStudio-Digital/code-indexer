import type { Hono } from 'hono';
import { stat } from 'node:fs/promises';
import type { ServerDeps } from '../deps.js';
import { parseIdParam, parseJsonBody, notFound } from './_helpers.js';

/**
 * Hygiene routes — surface the index health that hides in SQLite and
 * give the dashboard one-click cleanups for the most common drift:
 * orphan semantic items, mixed-case `files.language`,
 * stale "running" runs, and projects whose root_path was deleted on disk.
 *
 * The handlers are kept thin: every SQL-side operation lives on
 * `CodeIndexDB`, every local vector operation goes through the worker facade.
 * That way the same logic can be invoked by a CLI command later
 * without duplicating queries.
 */
export function mountHygieneRoutes(app: Hono, deps: ServerDeps): void {
  const { db, vectorStore, semanticCoordinator } = deps;

  /** Snapshot of per-project counters used by the Hygiene panel. */
  app.get('/api/hygiene/status', async (c) => {
    const projects = db.getProjectsHygiene();
    const tierRows = db.getProjectTierBreakdown();
    const tiersByProject = new Map<number, Record<string, number>>();
    for (const r of tierRows) {
      const bucket = tiersByProject.get(r.project_id) ?? {};
      bucket[r.tier] = r.count;
      tiersByProject.set(r.project_id, bucket);
    }

    // Filesystem probes can stall on offline/network roots. Keep them off the
    // Electron main loop and overlap them with the vector-worker health check.
    const [enriched, vectorStoreAvailable] = await Promise.all([
      Promise.all(projects.map(async (p) => {
        let missingOnDisk = false;
        try {
          missingOnDisk = !(await stat(p.root_path)).isDirectory();
        } catch {
          missingOnDisk = true;
        }
        return {
          ...p,
          missing_on_disk: missingOnDisk,
          tiers: tiersByProject.get(p.id) ?? {},
        };
      })),
      vectorStore.isAvailable().catch(() => false),
    ]);

    return c.json({
      projects: enriched,
      vector_store_available: vectorStoreAvailable,
    });
  });

  /**
   * Run every safe cleanup for one project: purge orphan semantic_items
   * and local vectors, normalize languages, close stale
   * runs. Returns a diff so the panel can surface what actually moved.
   */
  app.post('/api/hygiene/projects/:id/cleanup', async (c) => {
    const id = parseIdParam(c);
    const project = db.getProject(id);
    if (!project) return notFound(c);

    const orphans = db.getOrphanSemanticItems(id);
    let vectorsDeletedLocal = 0;
    let vectorError: string | null = null;

    if (orphans.length > 0 && vectorStore.deleteByItemKeys) {
      try {
        const byNamespace = new Map<string, Set<string>>();
        for (const orphan of orphans) {
          const keys = byNamespace.get(orphan.namespace) ?? new Set<string>();
          keys.add(orphan.item_key);
          byNamespace.set(orphan.namespace, keys);
        }
        for (const [namespace, keys] of byNamespace) {
          vectorsDeletedLocal += await vectorStore.deleteByItemKeys([...keys], namespace);
        }
      } catch (err) {
        vectorError = err instanceof Error ? err.message : String(err);
      }
    }

    const localDeleted = vectorError ? 0 : orphans.length;
    const langNormalized = db.normalizeFileLanguages(id);
    const staleRuns = db.markStaleRuns(2, id);

    return c.json({
      ok: true,
      orphan_semantic_items: orphans.length,
      vectors_deleted_local: vectorsDeletedLocal,
      local_deleted: localDeleted,
      languages_normalized: langNormalized,
      stale_runs_closed: staleRuns,
      vector_error: vectorError,
    });
  });

  /**
   * Bulk purge — for each project id passed in, run the same cascade
   * the DELETE /api/projects/:id route uses. Used by "Purge missing on
   * disk" in the panel. Body: `{ projectIds: number[], confirm: true }`.
   */
  app.post('/api/hygiene/projects/purge', async (c) => {
    const body = await parseJsonBody<{ projectIds: number[]; confirm: boolean }>(c);
    if (!body.confirm) {
      return c.json({ error: 'confirm flag required' }, 400);
    }
    const ids = Array.isArray(body.projectIds) ? body.projectIds : [];
    if (ids.length === 0) return c.json({ ok: true, purged: 0 });

    const summaries: Array<{
      project_id: number;
      vectors_known: number;
      vectors_deleted: number;
      vector_error: string | null;
    }> = [];

    for (const id of ids) {
      const project = db.getProject(id);
      if (!project) {
        summaries.push({
          project_id: id,
          vectors_known: 0,
          vectors_deleted: 0,
          vector_error: 'project not found',
        });
        continue;
      }
      const known = db.getProjectsHygiene().find((row) => row.id === id)?.vector_count ?? 0;
      let vectorsDeleted = 0;
      let vectorError: string | null = null;
      try {
        await semanticCoordinator.removeProject(id, {
          finalize: () => db.deleteProject(id),
        });
        vectorsDeleted = known;
      } catch (err) {
        vectorError = err instanceof Error ? err.message : String(err);
      }
      summaries.push({
        project_id: id,
        vectors_known: known,
        vectors_deleted: vectorsDeleted,
        vector_error: vectorError,
      });
    }

    return c.json({ ok: true, purged: summaries.length, summaries });
  });

  /**
   * Global SQL-only sweep — normalize languages and close stale
   * runs across every project without touching vector databases.
   */
  app.post('/api/hygiene/global/sql-cleanup', (c) => {
    const lang = db.normalizeFileLanguages();
    const stale = db.markStaleRuns(2);
    return c.json({
      ok: true,
      languages_normalized: lang,
      stale_runs_closed: stale,
    });
  });
}
