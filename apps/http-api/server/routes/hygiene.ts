import type { Hono } from 'hono';
import type { ServerDeps } from '../deps.js';
import { parseIdParam, parseJsonBody, notFound } from './_helpers.js';

/**
 * Hygiene routes — surface the index health that hides in SQLite and
 * give the dashboard one-click cleanups for the most common drift:
 * orphan vector ids, duplicate vector_ids, mixed-case `files.language`,
 * stale "running" runs, and projects whose root_path was deleted on disk.
 *
 * The handlers are kept thin: every SQL-side operation lives on
 * `CodeIndexDB`, every remote operation goes through `VectorStore`.
 * That way the same logic can be invoked by a CLI command later
 * without duplicating queries.
 */
export function mountHygieneRoutes(app: Hono, deps: ServerDeps): void {
  const { db, vectorStore } = deps;

  /** Snapshot of per-project counters used by the Hygiene panel. */
  app.get('/api/hygiene/status', async (c) => {
    const projects = db.getProjectsHygiene();
    const pendingTotal = db.countPendingVectorDeletes();
    const tierRows = db.getProjectTierBreakdown();
    const tiersByProject = new Map<number, Record<string, number>>();
    for (const r of tierRows) {
      const bucket = tiersByProject.get(r.project_id) ?? {};
      bucket[r.tier] = r.count;
      tiersByProject.set(r.project_id, bucket);
    }

    // Cheap stat() check — flagging projects whose root_path no longer
    // exists on disk lets the user purge them in bulk. We swallow ENOENT
    // and treat any other error as "unknown" rather than guessing.
    const fs = await import('node:fs');
    const enriched = projects.map((p) => {
      let missingOnDisk = false;
      try {
        const stat = fs.statSync(p.root_path);
        missingOnDisk = !stat.isDirectory();
      } catch {
        missingOnDisk = true;
      }
      return {
        ...p,
        missing_on_disk: missingOnDisk,
        tiers: tiersByProject.get(p.id) ?? {},
      };
    });

    let vectorStoreAvailable = false;
    try {
      vectorStoreAvailable = await vectorStore.isAvailable();
    } catch {
      vectorStoreAvailable = false;
    }

    return c.json({
      projects: enriched,
      pending_vector_deletes: pendingTotal,
      vector_store_available: vectorStoreAvailable,
    });
  });

  /**
   * Run every safe cleanup for one project: purge orphan vector_ids
   * (both remote and local), dedup, normalize languages, close stale
   * runs. Returns a diff so the panel can surface what actually moved.
   */
  app.post('/api/hygiene/projects/:id/cleanup', async (c) => {
    const id = parseIdParam(c);
    const project = db.getProject(id);
    if (!project) return notFound(c);

    const orphans = db.getOrphanVectorIds(id);
    let remoteDeleted = 0;
    let remoteError: string | null = null;

    if (orphans.length > 0) {
      try {
        remoteDeleted = await vectorStore.deleteByIds(orphans.map((o) => o.vector_id));
      } catch (err) {
        remoteError = err instanceof Error ? err.message : String(err);
        db.enqueuePendingVectorDeletes(
          orphans.map((o) => ({
            vector_id: o.vector_id,
            project_name: project.name,
            error: remoteError,
          })),
        );
      }
    }

    const localDeleted = db.deleteVectorIdRows(
      id,
      orphans.map((o) => o.vector_id),
    );
    const dedupRemoved = db.dedupVectorIds(id);
    const langNormalized = db.normalizeFileLanguages(id);
    const staleRuns = db.markStaleRuns(2, id);

    if (!remoteError) db.setProjectPendingVectorGc(id, false);

    return c.json({
      ok: true,
      orphan_vectors: orphans.length,
      remote_deleted: remoteDeleted,
      local_deleted: localDeleted,
      duplicates_removed: dedupRemoved,
      languages_normalized: langNormalized,
      stale_runs_closed: staleRuns,
      remote_error: remoteError,
    });
  });

  /**
   * Drain the pending_vector_deletes queue. Called when the panel's
   * "Retry pending GC" button is clicked. Batches at the vector store
   * level — `deleteByIds` already chunks by 1000 internally for
   * Cloudflare/Pinecone.
   */
  app.post('/api/hygiene/vectorize/retry', async (c) => {
    const batch = db.takePendingVectorDeletes(5000);
    if (batch.length === 0) {
      return c.json({ ok: true, attempted: 0, deleted: 0, remaining: 0 });
    }

    let deleted = 0;
    let remoteError: string | null = null;
    try {
      deleted = await vectorStore.deleteByIds(batch.map((r) => r.vector_id));
      // On success drop the queue rows we just satisfied.
      db.deletePendingVectorDeletesByIds(batch.map((r) => r.id));
    } catch (err) {
      remoteError = err instanceof Error ? err.message : String(err);
      // Bump attempt counter on the surviving rows so we can age them out.
      db.enqueuePendingVectorDeletes(
        batch.map((r) => ({
          vector_id: r.vector_id,
          project_name: r.project_name,
          error: remoteError,
        })),
      );
    }

    const remaining = db.countPendingVectorDeletes();
    return c.json({
      ok: !remoteError,
      attempted: batch.length,
      deleted,
      remaining,
      remote_error: remoteError,
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
      vectors_deleted_remote: number;
      remote_error: string | null;
    }> = [];

    for (const id of ids) {
      const project = db.getProject(id);
      if (!project) {
        summaries.push({
          project_id: id,
          vectors_known: 0,
          vectors_deleted_remote: 0,
          remote_error: 'project not found',
        });
        continue;
      }
      const vectorIds = db.snapshotVectorIdsForProject(id);
      let remoteDeleted = 0;
      let remoteError: string | null = null;
      if (vectorIds.length > 0) {
        try {
          remoteDeleted = await vectorStore.deleteByIds(vectorIds);
        } catch (err) {
          remoteError = err instanceof Error ? err.message : String(err);
          db.enqueuePendingVectorDeletes(
            vectorIds.map((vid) => ({
              vector_id: vid,
              project_name: project.name,
              error: remoteError,
            })),
          );
        }
      }
      db.deleteProject(id);
      summaries.push({
        project_id: id,
        vectors_known: vectorIds.length,
        vectors_deleted_remote: remoteDeleted,
        remote_error: remoteError,
      });
    }

    return c.json({ ok: true, purged: summaries.length, summaries });
  });

  /**
   * Global SQL-only sweep — dedup, normalize languages, close stale
   * runs across every project. No remote calls. Useful as a fast
   * "fix obvious things" before deciding what to do about Vectorize.
   */
  app.post('/api/hygiene/global/sql-cleanup', (c) => {
    const dedup = db.dedupVectorIds();
    const lang = db.normalizeFileLanguages();
    const stale = db.markStaleRuns(2);
    return c.json({
      ok: true,
      duplicates_removed: dedup,
      languages_normalized: lang,
      stale_runs_closed: stale,
    });
  });
}
