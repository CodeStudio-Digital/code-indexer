/**
 * Session deletion routes.
 *
 * The DELETE flow has to orchestrate cleanup across MULTIPLE artefact
 * stores — the container runtime (sandbox manager), the file system
 * (virtual-project dirs, workdir archive), the project rows
 * (synthetic `_builder_*` projects), and the dependency volumes
 * (`mcp-sbx-nm-*`). Mixed in with the regular session CRUD inside
 * `sessions.ts`, the body of this single handler grew past 150 LOC
 * and made the rest of the file harder to read. Phase 8 part 2 lifts
 * it (plus the `delete-plan` companion + the helpers they share) into
 * a focused module.
 *
 * Routes:
 *   - GET  /api/company/sessions/:id/delete-plan
 *     Returns a structured plan describing which directories/volumes
 *     CAN be removed alongside the session — fed into the dashboard's
 *     delete confirmation dialog so the operator can pick.
 *
 *   - DELETE /api/company/sessions/:id
 *     Body: { remove_project_paths?: string[], remove_node_modules_volumes?: string[] }
 *     Orchestrates the cascade: stop orchestrator → destroy sandbox →
 *     drop session row (cascades to agent_runs/kanban/etc) → remove
 *     selected virtual project dirs + the workdir archive + selected
 *     dependency volumes.
 */
import type { Hono } from 'hono';
import { rm } from 'node:fs/promises';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, notFound } from '../_helpers.js';
import { cleanupSessionPersistence, getSandboxManager } from '@mcp/services/sandbox/index.js';
import { sandboxArchivePath } from '@mcp/company/services/SandboxService.js';
import { getCompanyOrchestrator, deleteCompanyOrchestrator } from '../../../sse/companyOrchestrator.js';

/**
 * Names a dependency cache volume mirroring the convention used by
 * the sandbox manager. Exported because the delete-plan needs to
 * enumerate which volumes the cleanup CAN remove.
 */
export function nodeModulesVolumeName(sessionId: number | string, serviceId?: string): string {
  const safeSession = String(sessionId).replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 48);
  const base = `mcp-sbx-nm-${safeSession}`;
  return serviceId ? `${base}-${serviceId}` : base;
}

export function mountCompanySessionDeleteRoutes(app: Hono, deps: ServerDeps): void {
  const { db, companyStore, companySandboxStore, companySandboxServicesStore } = deps;

  function buildSessionDeletePlan(id: number) {
    const full = companyStore.getCompanySessionFull(id);
    const projectPaths: Array<{
      project_id: number;
      name: string;
      label: string | null;
      root_path: string;
      kind: 'owned' | 'external';
      removable: boolean;
    }> = [];
    if (full) {
      for (const link of full.projects) {
        const project = db.getProject(link.project_id);
        if (!project?.root_path) continue;
        const owned = project.name.startsWith('_builder_');
        projectPaths.push({
          project_id: project.id,
          name: project.name,
          label: link.label ?? null,
          root_path: project.root_path,
          kind: owned ? 'owned' : 'external',
          removable: owned,
        });
      }
    }

    const volumes: Array<{ name: string; label: string; removable: boolean }> = [];
    const primary = companySandboxStore.get(id);
    if (primary && primary.mount_kind !== 'external') {
      volumes.push({ name: nodeModulesVolumeName(id), label: 'main node_modules', removable: true });
    }
    for (const row of companySandboxServicesStore.listBySessionAll(id)) {
      if (row.mount_kind === 'external') continue;
      volumes.push({
        name: nodeModulesVolumeName(id, row.service_id),
        label: `${row.service_id} node_modules`,
        removable: true,
      });
    }

    return {
      project_paths: projectPaths,
      node_modules_volumes: volumes,
    };
  }

  app.get('/api/company/sessions/:id/delete-plan', (c) => {
    const id = parseIdParam(c);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);
    return c.json(buildSessionDeletePlan(id));
  });

  app.delete('/api/company/sessions/:id', async (c) => {
    const id = parseIdParam(c);
    const deleteBody = (await c.req.json().catch(() => ({}))) as {
      remove_project_paths?: string[];
      remove_node_modules_volumes?: string[];
    };
    const selectedProjectPaths = new Set(
      Array.isArray(deleteBody.remove_project_paths)
        ? deleteBody.remove_project_paths.filter((p): p is string => typeof p === 'string')
        : [],
    );
    const deletePlan = buildSessionDeletePlan(id);
    const removableProjectPaths = new Set(
      deletePlan.project_paths.filter((p) => p.removable).map((p) => p.root_path),
    );
    const selectedVolumes = new Set(
      Array.isArray(deleteBody.remove_node_modules_volumes)
        ? deleteBody.remove_node_modules_volumes.filter((v): v is string => typeof v === 'string')
        : [],
    );
    const removableVolumes = new Set(
      deletePlan.node_modules_volumes.filter((v) => v.removable).map((v) => v.name),
    );
    const nodeModulesVolumeNames = [...selectedVolumes].filter((name) =>
      removableVolumes.has(name),
    );

    // ── Collect disposable artefacts BEFORE deleting the DB rows ──
    //
    // Once `deleteCompanySession` runs, the join rows between session
    // and project are gone (ON DELETE CASCADE), and we can no longer
    // identify which projects were the synthetic `_builder_*` ones.
    // Same goes for root_paths — we need them now so selected disk
    // dirs can be removed after the session row cascades away.
    let virtualProjects: Array<{ id: number; rootPath: string }> = [];
    let cleanupMountKind: 'owned' | 'external' = 'owned';
    let builtImageTags: string[] = [];
    try {
      const primarySandboxRow = companySandboxStore.get(id);
      if (primarySandboxRow?.mount_kind === 'external') cleanupMountKind = 'external';
      builtImageTags = [
        primarySandboxRow?.built_image_tag,
        ...companySandboxServicesStore
          .listBySessionAll(id)
          .map((row) => row.built_image_tag),
      ].filter((tag): tag is string => !!tag);
      const full = companyStore.getCompanySessionFull(id);
      if (full) {
        virtualProjects = full.projects
          .map((p) => db.getProject(p.project_id))
          .filter((p): p is NonNullable<typeof p> => !!p && p.name.startsWith('_builder_'))
          .map((p) => ({ id: p.id, rootPath: p.root_path }));
      }
    } catch {
      // Best-effort — a read failure here should not block the delete.
    }

    // ── Stop anything still running for this session ──
    //
    // 1. If a master/company orchestrator is live, abort it. That
    //    also fires `sandboxService.teardown()` → destroys the
    //    container AND writes the workdir archive (which we'll
    //    promptly delete below — acceptable, the archive write is
    //    cheap and the code path stays uniform).
    // 2. If no orchestrator is live but a sandbox still lingers in
    //    the manager map (TTL-alive after the user left the tab),
    //    destroy it directly.
    try {
      const orch = getCompanyOrchestrator(id);
      if (orch) {
        orch.abortAll();
        deleteCompanyOrchestrator(id);
      }
    } catch (e) {
      console.warn(
        `[company] abort orchestrator ${id} during delete failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    try {
      await getSandboxManager().destroy(String(id), 'session-deleted');
    } catch (e) {
      console.warn(
        `[company] destroy sandbox ${id} during delete failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // ── Delete the DB row (cascades to agent_runs, kanban, etc) ──
    const deleted = companyStore.deleteCompanySession(id);
    if (!deleted) return notFound(c);

    // ── Remove virtual project rows; remove host dirs only when selected ──
    //
    // User-linked (non-virtual) projects are NEVER auto-removed, even
    // if this was their only session. Only our synthetic `_builder_`
    // projects get cleaned up.
    for (const vp of virtualProjects) {
      try {
        db.deleteProject(vp.id);
      } catch (e) {
        console.warn(
          `[company] delete virtual project row ${vp.id} failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      if (vp.rootPath && selectedProjectPaths.has(vp.rootPath) && removableProjectPaths.has(vp.rootPath)) {
        try {
          await rm(vp.rootPath, { recursive: true, force: true });
        } catch (e) {
          console.warn(
            `[company] remove virtual project dir ${vp.rootPath} failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }

    // ── Remove the persisted workdir archive ──
    //
    // `SandboxService.teardown()` writes it on abort/idle. Keeping
    // it around after an explicit delete is just landfill — the user
    // said "I'm done with this session."
    try {
      await rm(sandboxArchivePath(id), { force: true });
    } catch (e) {
      console.warn(
        `[company] remove sandbox archive for session ${id} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // ── Remove selected dependency volumes only ──
    //
    // When the sandbox ran under the persistent bind-mount layout
    // (`data/virtual-projects/<sessionId>` + `mcp-sbx-nm-<id>` volume),
    // the container destroy above leaves dependency volumes behind.
    // Remove only the names selected in the delete dialog.
    await cleanupSessionPersistence(String(id), {
      mountKind: cleanupMountKind,
      builtImageTags,
      removeHostWorkdir: false,
      removeNodeModulesVolume: false,
      nodeModulesVolumeNames,
    });

    return c.json({ ok: true });
  });
}
