/**
 * `GET /api/company/sessions/:id/services` — list every microservice
 * + the synthesized primary + historical orphans.
 *
 * Extracted from `services.ts` to keep the file under the LOC cap; the
 * merge logic (persisted row ∪ live manager state ∪ legacy primary ∪
 * orphaned project links) is chunky enough to deserve its own file.
 */
import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, notFound } from '../_helpers.js';
import { getSandboxManager, inferPreviewStrategy } from '@mcp/services/sandbox/index.js';
import { getLocalProcessManager } from '@mcp/services/sandbox/local-process/LocalProcessManager.js';

export function mountCompanyServicesListRoute(app: Hono, deps: ServerDeps): void {
  const { companyStore, db } = deps;

  app.get('/api/company/sessions/:id/services', (c) => {
    const id = parseIdParam(c);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);
    // Pull every row (including `status='destroyed'` tombstones kept
    // by the soft-delete path of `destroyService`) so the UI can
    // surface orphans. The legacy filter hid them, which is why
    // session 68's `api-worker` vanished despite its project files
    // still living on disk.
    const persisted = deps.companySandboxServicesStore.listBySessionAll(id);
    const manager = getSandboxManager();
    const live = new Map(
      manager
        .listServices(String(id))
        .map((sb) => [sb.id.split(':')[1] ?? '', sb] as const),
    );
    const services = persisted.map((row) => {
      const liveSb = live.get(row.service_id);
      const runtimePaused = !!liveSb?.runtimePaused;
      const liveStatus = runtimePaused ? 'paused' : liveSb?.status ?? row.status;
      // Rows in the DB with `status='destroyed'` and no live Map
      // entry are orphans (soft-deleted by a transient teardown).
      // Report as `'orphaned'` so the UI can show a Retry/Remove
      // affordance instead of a running badge.
      const isOrphaned = !liveSb && row.status === 'destroyed';
      const isAttached = row.is_attached === 1;
      const mountKind = (row.mount_kind ?? 'owned') as 'owned' | 'external';
      const imageSource = (row.image_source ?? 'default') as 'default' | 'project_dockerfile';
      // Phase 4: derive `preview_strategy` from persisted metadata. The
      // override-via-UI feature would persist an explicit column, but for
      // now the heuristic in `inferPreviewStrategy` covers the cases the
      // user actually hits (external mounts + Dockerfile builds run their
      // own dev server config that we can't rewrite into `/preview/${id}/`).
      const previewStrategy = inferPreviewStrategy({
        stack: row.stack,
        mountKind,
        fromProjectDockerfile: imageSource === 'project_dockerfile',
      });
      return {
        service_id: row.service_id,
        name: row.name || row.service_id,
        stack: row.stack,
        status: isOrphaned ? 'paused' : liveStatus,
        runtime_paused: runtimePaused,
        step: liveSb?.step ?? 'queued',
        host_port: row.host_port,
        preview_url: liveSb?.previewUrl ?? null,
        preview_strategy: previewStrategy,
        is_primary: !!row.is_primary,
        error: liveSb?.error ?? row.error ?? (isOrphaned && !isAttached ? 'Container is not present. Press Play to recreate it.' : null),
        created_at: row.created_at,
        mount_kind: mountKind,
        image_source: imageSource,
        is_attached: isAttached,
        external_container_ref: row.external_container_ref ?? null,
        attached_hostname: row.attached_hostname ?? null,
        // B6 — supervisor health projection (mig 188 columns) + approximate
        // uptime anchor (live manager provision timestamp, epoch ms).
        health: row.health ?? 'unknown',
        health_detail: row.health_detail ?? null,
        last_health_at_ms: row.last_health_at_ms ?? null,
        restart_count: row.restart_count ?? 0,
        started_at_ms: liveSb?.createdAt ?? null,
      };
    });

    // Legacy single-container sessions only persist the primary in
    // `company_sandboxes` — it never lands in `company_sandbox_services`,
    // so the UI listing above would hide it entirely. Synthesize a
    // primary row when no persisted service is flagged is_primary,
    // merging DB (source of truth on restart) with live manager state
    // (for provisioning → ready transitions). Mirrors the behavior of
    // the master's `list_containers` tool at master-tools.ts:591.
    const alreadyHasPrimary = services.some((s) => s.is_primary);
    if (!alreadyHasPrimary) {
      const sandboxRow = deps.companySandboxStore.get(id);
      const liveMain = manager.get(String(id));
      if (sandboxRow || liveMain) {
        const runtimePaused = !!liveMain?.runtimePaused;
        const mountKind = (liveMain?.mountKind ?? sandboxRow?.mount_kind ?? 'owned') as 'owned' | 'external';
        const imageSource = (liveMain?.imageSource ?? sandboxRow?.image_source ?? 'default') as
          | 'default'
          | 'project_dockerfile';
        services.unshift({
          service_id: 'main',
          name: 'main',
          stack: liveMain?.stack ?? sandboxRow?.stack ?? '',
          status: runtimePaused ? 'paused' : liveMain?.status ?? sandboxRow?.status ?? 'paused',
          runtime_paused: runtimePaused,
          step: liveMain?.step ?? 'queued',
          host_port: liveMain?.hostPort ?? sandboxRow?.host_port ?? 0,
          preview_url: liveMain?.previewUrl ?? null,
          preview_strategy: inferPreviewStrategy({
            stack: liveMain?.stack ?? sandboxRow?.stack ?? '',
            mountKind,
            fromProjectDockerfile: imageSource === 'project_dockerfile',
          }),
          is_primary: true,
          error: liveMain?.error ?? sandboxRow?.error ?? null,
          created_at: sandboxRow?.created_at ?? new Date().toISOString(),
          mount_kind: mountKind,
          image_source: imageSource,
          is_attached: false,
          external_container_ref: null,
          attached_hostname: null,
          // The legacy primary has no company_sandbox_services row, so the
          // supervisor's health write no-ops for it — report 'unknown'.
          health: 'unknown',
          health_detail: null,
          last_health_at_ms: null,
          restart_count: 0,
          started_at_ms: liveMain?.createdAt ?? null,
        });
      }
    }

    // Historical orphans: project links in `company_session_projects`
    // (label != null) that have NO row at all in `company_sandbox_services`.
    // These pre-date the soft-delete behavior above — session 68 is
    // the canonical example. Surface them with `status='orphaned'`
    // and include `project_id` + `root_path` so the UI can tell the
    // user where the files live and offer a Retry that resurrects
    // the container with the same bind-mount.
    const seen = new Set(services.map((s) => s.service_id));
    type SidecarService = typeof services[number] & {
      project_id?: number;
      root_path?: string;
      /** B8 — discriminates host-process rows; absent = container. */
      kind?: 'local';
    };
    const augmented: SidecarService[] = services.slice();
    for (const link of companyStore.listCompanySessionProjects(id)) {
      if (!link.label) continue;
      if (seen.has(link.label)) continue;
      const project = db.getProject(link.project_id);
      const mountKind = (project?.name?.startsWith('_builder_') ? 'owned' : 'external') as
        | 'owned'
        | 'external';
      augmented.push({
        service_id: link.label,
        name: project?.name ?? link.label,
        stack: '',
        status: 'paused',
        runtime_paused: false,
        step: 'queued',
        host_port: 0,
        preview_url: null,
        preview_strategy: inferPreviewStrategy({ mountKind }),
        is_primary: false,
        error:
          'Service container is gone but project files are intact. Click Retry to re-provision.',
        created_at: new Date().toISOString(),
        project_id: link.project_id,
        root_path: project?.root_path ?? '',
        mount_kind: mountKind,
        image_source: 'default',
        is_attached: false,
        external_container_ref: null,
        attached_hostname: null,
        health: 'unknown',
        health_detail: null,
        last_health_at_ms: null,
        restart_count: 0,
        started_at_ms: null,
      });
      seen.add(link.label);
    }

    // B8 — the session's HOST process (LocalProcessManager) as a read-only
    // row under `service_id: 'local:<id>'`. This route runs on the main
    // process, so the LPM singleton is authoritative when live; the
    // persisted row covers the post-crash case (`listBySession` already
    // hides destroyed rows). Health is deliberately 'unknown' here: the
    // supervisor keeps host-process health in WORKER memory only (no
    // company_sandbox_services row, no migration) and the dashboard
    // receives live verdicts via the `sandbox.service.health` SSE events.
    const liveLocal = getLocalProcessManager().get(String(id));
    const localRow = deps.companyLocalProjectStore.listBySession(id);
    if (liveLocal || localRow) {
      const cwd = liveLocal?.cwd ?? localRow?.cwd ?? '';
      const label = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'local';
      augmented.push({
        service_id: `local:${id}`,
        kind: 'local',
        name: label,
        stack: 'local-process',
        status: liveLocal?.status ?? localRow?.status ?? 'error',
        runtime_paused: false,
        step: liveLocal?.status === 'running' ? 'ready' : 'queued',
        host_port: liveLocal?.hostPort ?? localRow?.host_port ?? 0,
        preview_url: liveLocal?.previewUrl ?? null,
        preview_strategy: inferPreviewStrategy({ mountKind: 'external' }),
        is_primary: false,
        error: liveLocal?.error ?? localRow?.error ?? null,
        created_at: localRow?.created_at ?? new Date().toISOString(),
        mount_kind: 'external',
        image_source: 'default',
        is_attached: false,
        external_container_ref: null,
        attached_hostname: null,
        health: 'unknown',
        health_detail: null,
        last_health_at_ms: null,
        restart_count: 0,
        started_at_ms: liveLocal?.createdAt ?? null,
      });
    }

    return c.json({ services: augmented });
  });
}
