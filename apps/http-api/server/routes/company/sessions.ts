import type { Hono } from 'hono';
import { mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import { cleanupSessionPersistence, getSandboxManager } from '@mcp/services/sandbox/index.js';
import { detectDockerfile } from '@mcp/services/sandbox/dockerfile-detector.js';
import { detectManifest } from '@mcp/services/sandbox/manifest-detector/detect.js';
import type { NodeManifest } from '@mcp/services/sandbox/manifest-detector/types.js';
import {
  BUILDER_STACKS,
  PROVISIONABLE_STACKS,
  type Sandbox,
  type BuilderStack,
  type ProvisionableStack,
} from '@mcp/services/sandbox/types.js';
import { StackSnapshotSeeder } from '@mcp/company/services/stack-snapshot-seeder.js';
import { sandboxArchivePath } from '@mcp/company/services/SandboxService.js';
import { orchestratorRegistry } from '../../../sse/OrchestratorRegistry.js';
import { formatSetCookie, mintPreviewToken } from '../preview-auth.js';

interface CreateSessionBody {
  template_id?: number;
  name: string;
  project_ids: number[];
  project_labels?: Record<number, string>;
  master_provider: string;
  master_model: string;
  role_assignments?: Array<{
    role: string;
    provider: string;
    model: string;
    project_ids: number[];
    tier?: string;
  }>;
  /**
   * When set, flips the session into builder ("v0-style") mode. The
   * company orchestrator provisions an ephemeral OCI sandbox on start,
   * pipes tool writes into it and exposes a live dev-server preview.
   * Absence of this field preserves the traditional company-session flow.
   */
  builder?: {
    stack: BuilderStack;
    /** Per-session CPU/memory/pids override. Partial — any missing field
     *  falls back to process-level defaults (MCP_SANDBOX_* env). */
    limits?: {
      memory?: string;
      cpus?: string;
      pids?: number;
    };
    /** Existing linked project to run via bind-mount + project Dockerfile. */
    main_project_id?: number;
    /** Runtime for existing main project: production Dockerfile or dev package.json. */
    main_project_runtime?: ExternalProjectRuntime;
  };
  /**
   * Curated pool of `(provider, model)` tuples the master is allowed
   * to spawn subordinates with. When present (length > 0), the master's
   * `spawn_subordinate_agent` tool will REFUSE models outside this
   * list; the tool error names the valid options so the master can
   * self-correct on retry. Absence preserves the previous free-form
   * behavior.
   */
  allowed_models?: Array<{
    provider: string;
    model: string;
    label?: string;
    notes?: string;
    is_default?: boolean;
  }>;
}

/**
 * Validate a proposed allowed_models pool + the derived session config:
 *   - Every entry has non-empty provider + model strings.
 *   - At most one entry is marked is_default.
 *   - If the list is non-empty, `master_model` MUST be one of the
 *     entries (otherwise the master can't run).
 *   - If `role_assignments` is also set, every role's (provider, model)
 *     MUST also be in the pool — we refuse to persist a template whose
 *     own assignments can't be spawned.
 */
function validateAllowedModels(
  pool: NonNullable<CreateSessionBody['allowed_models']>,
  body: Partial<CreateSessionBody>,
): string | null {
  if (pool.length === 0) return null;
  let defaults = 0;
  for (const [i, entry] of pool.entries()) {
    if (!entry.provider?.trim() || !entry.model?.trim()) {
      return `allowed_models[${i}]: provider and model are required`;
    }
    if (entry.is_default) defaults++;
  }
  if (defaults > 1) {
    return `allowed_models has ${defaults} default entries — at most one may be default`;
  }
  const has = (p: string, m: string) =>
    pool.some((e) => e.provider === p && e.model === m);
  if (body.master_provider && body.master_model && !has(body.master_provider, body.master_model)) {
    return (
      `master model '${body.master_provider}/${body.master_model}' is not in allowed_models. ` +
      `Add it to the pool or pick one of: ${pool.map((e) => `${e.provider}/${e.model}`).join(', ')}`
    );
  }
  for (const role of body.role_assignments ?? []) {
    if (!has(role.provider, role.model)) {
      return (
        `role_assignments['${role.role}'] uses '${role.provider}/${role.model}' which is ` +
        `not in allowed_models. Every role must be spawn-able from the pool.`
      );
    }
  }
  return null;
}

/**
 * Parse a YAML OpenAPI document into a plain JS object. Loaded lazily so
 * the `yaml` package isn't on the http-api boot path — the API Reference
 * tab is the only consumer.
 */
async function parseOpenApiYaml(raw: string): Promise<unknown> {
  const mod = (await import('yaml')) as { parse: (s: string) => unknown };
  return mod.parse(raw);
}

const BUILDER_STACKS_SET: ReadonlySet<string> = new Set(BUILDER_STACKS);
function isBuilderStack(s: unknown): s is BuilderStack {
  return typeof s === 'string' && BUILDER_STACKS_SET.has(s);
}
const PROVISIONABLE_STACKS_SET: ReadonlySet<string> = new Set(PROVISIONABLE_STACKS);
/**
 * Permissive variant of {@link isBuilderStack} used by the sandbox
 * lifecycle routes (GET/POST /sandbox, restart-dev, logs). Accepts the
 * internal stacks (`'node-only'`) that aren't user-pickable but still
 * back real containers — without this, DS sessions can't have their
 * sandbox inspected or re-provisioned via the dashboard / API.
 */
function isProvisionableStack(s: unknown): s is ProvisionableStack {
  return typeof s === 'string' && PROVISIONABLE_STACKS_SET.has(s);
}

type ExternalProjectRuntime = 'dockerfile' | 'node';

function isExternalProjectRuntime(value: unknown): value is ExternalProjectRuntime {
  return value === 'dockerfile' || value === 'node';
}

function inferPortFromNodeScript(script: string): number | null {
  const match =
    script.match(/(?:^|\s)--port(?:=|\s+)(\d{2,5})(?=\s|$)/) ??
    script.match(/(?:^|\s)-p\s+(\d{2,5})(?=\s|$)/);
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

function inferNodeDevPort(stack: BuilderStack | ProvisionableStack, manifest: NodeManifest): number {
  const scriptName = manifest.devScriptName;
  const script = scriptName ? manifest.scripts[scriptName]?.toLowerCase() ?? '' : '';
  const scriptedPort = inferPortFromNodeScript(script);
  if (scriptedPort) return scriptedPort;
  if (stack === 'angular' || /\bng\s+serve\b/.test(script)) return 4200;
  if (/\bnext\s+(dev|start)\b/.test(script)) return 3000;
  return 5173;
}

function resolveExternalProjectSpec(
  rootPath: string,
  stack: BuilderStack | ProvisionableStack,
  requestedRuntime?: ExternalProjectRuntime,
):
  | {
      mountKind: 'external';
      imageSource: 'project_dockerfile';
      dockerfilePath: string;
      containerPortOverride: number;
      skipDefaultCommand: true;
    }
  | {
      mountKind: 'external';
      imageSource: 'default';
      containerPortOverride: number;
      skipDefaultCommand: false;
    } {
  const manifest = detectManifest(rootPath);
  const dockerfile = detectDockerfile(rootPath);
  const runtime =
    requestedRuntime ??
    (manifest?.kind === 'node' && manifest.devScriptName ? 'node' : 'dockerfile');

  if (runtime === 'node') {
    if (!manifest || manifest.kind !== 'node' || !manifest.devScriptName) {
      throw new Error(
        'Node dev image requires package.json with a dev, start, or serve script.',
      );
    }
    return {
      mountKind: 'external',
      imageSource: 'default',
      containerPortOverride: inferNodeDevPort(stack, manifest),
      skipDefaultCommand: false,
    };
  }

  const firstPort = dockerfile?.exposedPorts[0];
  if (!dockerfile || !firstPort) {
    throw new Error(
      "Dockerfile mode requires Dockerfile or Containerfile with EXPOSE <port>. Choose Node dev image for package.json projects.",
    );
  }
  return {
    mountKind: 'external',
    imageSource: 'project_dockerfile',
    dockerfilePath: dockerfile.path,
    containerPortOverride: firstPort,
    skipDefaultCommand: true,
  };
}
// Lightweight sanity validation. We don't parse the units — Podman/Docker
// will reject `"pancakes"` at run time with a clear error. The point here
// is to stop obvious nonsense (empty strings, NaN) before it's persisted.
const MEMORY_RE = /^\d+(\.\d+)?\s*(b|k|m|g|kb|mb|gb|ki|mi|gi)?$/i;
const CPUS_RE = /^\d+(\.\d+)?$/;
function validateLimits(limits: NonNullable<CreateSessionBody['builder']>['limits']): string | null {
  if (!limits) return null;
  if (limits.memory !== undefined && !MEMORY_RE.test(limits.memory)) {
    return `Invalid builder.limits.memory: '${limits.memory}'. Expected e.g. '512m', '1g', '2048'.`;
  }
  if (limits.cpus !== undefined && !CPUS_RE.test(limits.cpus)) {
    return `Invalid builder.limits.cpus: '${limits.cpus}'. Expected a number like '0.5', '1', '2'.`;
  }
  if (limits.pids !== undefined && (!Number.isInteger(limits.pids) || limits.pids < 16)) {
    return `Invalid builder.limits.pids: '${limits.pids}'. Expected integer ≥ 16.`;
  }
  return null;
}

export function mountCompanySessionRoutes(app: Hono, deps: ServerDeps): void {
  const { companyStore, db, snapshotService } = deps;
  const stackSnapshotSeeder = new StackSnapshotSeeder(snapshotService);

  /**
   * Tear down a microservice: destroys the container (via orchestrator
   * if alive, or the sandbox manager directly if offline), then unlinks
   * and deletes its virtual `_builder_*` project row + host workdir.
   *
   * Shared between DELETE /services/:serviceId and DELETE
   * /projects/:projectId so the two entry points can't drift.
   */
  async function removeServiceAndProject(id: number, serviceId: string): Promise<void> {
    const linked = companyStore
      .listCompanySessionProjects(id)
      .find((p) => p.label === serviceId);
    const linkedProject = linked ? db.getProject(linked.project_id) : null;
    const serviceRow = deps.companySandboxServicesStore.get(id, serviceId);
    const isExternalProject =
      serviceRow?.mount_kind === 'external' ||
      (!!linkedProject && !linkedProject.name.startsWith('_builder_'));
    const isAttached = serviceRow?.is_attached === 1;

    if (isAttached) {
      // Attached services never had a podman container we own and never
      // had a `_builder_*` project row. Just drop the in-memory entry
      // (so list_containers/list_services stop reporting it) and the
      // persisted row. The user's container keeps running outside.
      await getSandboxManager()
        .destroyService(String(id), serviceId, 'user-removed')
        .catch(() => void 0);
      deps.companySandboxServicesStore.delete(id, serviceId);
      return;
    }

    const orch = orchestratorRegistry.get(id);
    if (orch) {
      await orch.sandboxService.removeService(serviceId);
    } else {
      await getSandboxManager()
        .destroyService(String(id), serviceId, 'user-removed-offline')
        .catch(() => void 0);
      deps.companySandboxServicesStore.delete(id, serviceId);
    }

    if (linkedProject) {
      try {
        companyStore.removeProjectFromCompanySession(id, linkedProject.id);
      } catch { /* best effort */ }
      if (isExternalProject) {
        return;
      }
      if (linkedProject.name.startsWith('_builder_') && linkedProject.root_path) {
        try {
          await rm(linkedProject.root_path, { recursive: true, force: true });
        } catch (e) {
          console.warn(
            `[sessions] failed to wipe service root_path ${linkedProject.root_path}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        try { db.deleteProject(linkedProject.id); } catch { /* best effort */ }
      }
    } else if (linked) {
      // Link existed but project row was already gone (orphan). Drop
      // the dangling link so it doesn't keep showing up as `project-<id>`.
      try {
        companyStore.removeProjectFromCompanySession(id, linked.project_id);
      } catch { /* best effort */ }
    }
  }

  async function startPrimarySandboxForSession(
    id: number,
    retry = false,
  ): Promise<
    | { ok: true; sandbox: Sandbox }
    | { ok: false; status: 400 | 404 | 409 | 500; error: string }
  > {
    const session = companyStore.getCompanySession(id);
    if (!session) return { ok: false, status: 404, error: 'session not found' };

    let stack: ProvisionableStack | null = null;
    let limits: { memory?: string; cpus?: string; pids?: number } | undefined;
    let cfg: {
      builder?: {
        stack?: string;
        limits?: { memory?: string; cpus?: string; pids?: number };
        main_project_id?: number;
        main_project_runtime?: ExternalProjectRuntime;
      };
    } = {};
    try {
      cfg = JSON.parse(session.config_json || '{}') as typeof cfg;
      if (isProvisionableStack(cfg.builder?.stack)) stack = cfg.builder.stack;
      if (cfg.builder?.limits) limits = cfg.builder.limits;
    } catch {
      /* treat as non-builder */
    }
    if (!stack) {
      return { ok: false, status: 409, error: 'session was not created with builder mode' };
    }

    const mainProjectId = cfg.builder?.main_project_id;
    const linkedProjects = companyStore.listCompanySessionProjects(id);
    const primaryLink =
      mainProjectId != null
        ? linkedProjects.find((p) => p.project_id === mainProjectId)
        : linkedProjects.find((p) => !p.label) ?? linkedProjects[0];
    const primaryProject = primaryLink ? db.getProject(primaryLink.project_id) : null;
    const hostWorkdirMount = primaryProject?.root_path ?? undefined;
    let externalSpec:
      | ReturnType<typeof resolveExternalProjectSpec>
      | {};
    if (mainProjectId != null) {
      if (!primaryProject) {
        return { ok: false, status: 404, error: `Project ${mainProjectId} not found` };
      }
      try {
        externalSpec = resolveExternalProjectSpec(
          primaryProject.root_path,
          stack as BuilderStack,
          cfg.builder?.main_project_runtime,
        );
      } catch (e) {
        return {
          ok: false,
          status: 400,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    } else {
      externalSpec = {};
    }

    try {
      const sandbox = await getSandboxManager().provision({
        sessionId: String(id),
        stack,
        retry,
        limits,
        hostWorkdirMount,
        ...externalSpec,
      });
      return { ok: true, sandbox };
    } catch (e) {
      return {
        ok: false,
        status: 500,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /**
   * Reject lifecycle calls (start/pause/unpause/restart/retry) on
   * services that reference an externally-managed container. The
   * platform never starts/stops these — only `inspect` is allowed.
   * Returns `null` when the call is permitted.
   */
  function rejectIfAttached(
    id: number,
    serviceId: string,
  ): { status: 409; error: string } | null {
    const row = deps.companySandboxServicesStore.get(id, serviceId);
    if (row?.is_attached === 1) {
      return {
        status: 409,
        error:
          "This service is an externally-managed container — manage its lifecycle from your host (podman start/stop). Use Refresh to update its status.",
      };
    }
    return null;
  }

  function serviceStartPayload(
    serviceId: string,
    sb: Sandbox,
  ) {
    return {
      ok: true,
      service_id: serviceId,
      status: sb.runtimePaused ? 'paused' : sb.status,
      runtime_paused: !!sb.runtimePaused,
      preview_url: sb.previewUrl,
      container_id: sb.containerId,
    };
  }

  function nodeModulesVolumeName(sessionId: number | string, serviceId?: string): string {
    const safeSession = String(sessionId).replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 48);
    const base = `mcp-sbx-nm-${safeSession}`;
    return serviceId ? `${base}-${serviceId}` : base;
  }

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
    const primary = deps.companySandboxStore.get(id);
    if (primary && primary.mount_kind !== 'external') {
      volumes.push({ name: nodeModulesVolumeName(id), label: 'main node_modules', removable: true });
    }
    for (const row of deps.companySandboxServicesStore.listBySessionAll(id)) {
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

  app.get('/api/company/sessions', (c) => {
    const status = c.req.query('status') as 'idle' | 'running' | 'completed' | undefined;
    return c.json(companyStore.listCompanySessions(status ? { status } : undefined));
  });

  app.get('/api/company/sessions/:id', (c) => {
    const id = parseIdParam(c);
    // Drop any link rows whose target project no longer exists. This
    // cleans up orphans from older versions that deleted the project
    // without unlinking — they'd otherwise keep showing up as
    // `project-<id>` in the sidebar forever.
    try {
      companyStore.pruneOrphanCompanySessionProjects(id);
    } catch (e) {
      console.warn(
        `[company] prune orphan projects for session ${id} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const full = companyStore.getCompanySessionFull(id);
    if (!full) return notFound(c);

    // Enrich projects with names
    const enrichedProjects = full.projects.map((p) => {
      const proj = db.getProject(p.project_id);
      return {
        ...p,
        project_name: proj?.name ?? `project-${p.project_id}`,
        root_path: proj?.root_path ?? '',
      };
    });

    return c.json({
      ...full,
      projects: enrichedProjects,
    });
  });

  app.post('/api/company/sessions/:id/duplicate', (c) => {
    const id = parseIdParam(c);
    const source = companyStore.getCompanySession(id);
    if (!source) return notFound(c);
    const newSession = companyStore.duplicateCompanySession(id, `${source.name} (cópia)`);
    return c.json({ session: newSession }, 201);
  });

  app.post('/api/company/sessions', async (c) => {
    const body = await parseJsonBody<CreateSessionBody>(c);
    const isBuilder = !!body.builder;
    // Builder sessions run inside an ephemeral container and don't need
    // a pre-existing host project. For the traditional flow a project
    // link is still mandatory (the orchestrator wouldn't know which
    // workspace to operate on).
    if (!body.name || (!isBuilder && !body.project_ids?.length)) {
      return c.json(
        { error: isBuilder ? 'name required' : 'name and project_ids required' },
        400,
      );
    }

    // Validate all user-provided projects exist (may be empty for builder).
    for (const pid of body.project_ids ?? []) {
      const proj = db.getProject(pid);
      if (!proj) return c.json({ error: `Project ${pid} not found` }, 404);
    }

    if (body.builder && (body.project_ids?.length ?? 0) > 0) {
      const mainProjectId = body.builder.main_project_id;
      if (!Number.isInteger(mainProjectId)) {
        return c.json(
          {
            error:
              'builder.main_project_id is required when creating a builder session from existing projects',
          },
          400,
        );
      }
      if (!(body.project_ids ?? []).includes(mainProjectId!)) {
        return c.json(
          { error: 'builder.main_project_id must be included in project_ids' },
          400,
        );
      }
      if (
        body.builder.main_project_runtime !== undefined &&
        !isExternalProjectRuntime(body.builder.main_project_runtime)
      ) {
        return c.json(
          { error: "builder.main_project_runtime must be 'dockerfile' or 'node'" },
          400,
        );
      }
    }

    // Builder + no explicit projects → spin up a virtual project so the
    // rest of the orchestrator (which assumes one project per session
    // minimum) keeps working. The project is a pure bookkeeping row:
    // its `root_path` points at an empty host directory that nobody
    // writes into during a builder session (runCoder pins `cwd` to the
    // sandbox workdir; see ../../../../../core/coder/index.ts).
    let effectiveProjectIds = body.project_ids ?? [];
    if (isBuilder && effectiveProjectIds.length === 0) {
      const uuid = randomUUID();
      const rootPath = join(process.cwd(), 'data', 'virtual-projects', uuid);
      try {
        mkdirSync(rootPath, { recursive: true });
      } catch (e) {
        return c.json(
          { error: `Failed to prepare virtual-project directory: ${e instanceof Error ? e.message : String(e)}` },
          500,
        );
      }
      // `_builder_<uuid>` keeps these synthetic rows identifiable in
      // the projects table (UI can filter them out if desired) and
      // avoids colliding with the UNIQUE `name` constraint.
      const virtualProject = db.createProject(
        `_builder_${uuid}`,
        rootPath,
        `Virtual project auto-created for builder session "${body.name.trim()}"`,
      );
      effectiveProjectIds = [virtualProject.id];
    }

    // Validate `builder.stack` early — a bad stack at this layer will
    // surface as a scaffolder lookup failure deep in session start,
    // which is a worse user experience than a 400 here.
    if (body.builder && !isBuilderStack(body.builder.stack)) {
      return c.json({ error: `Unsupported builder.stack: ${body.builder.stack}` }, 400);
    }
    if (body.builder) {
      const limitsErr = validateLimits(body.builder.limits);
      if (limitsErr) return c.json({ error: limitsErr }, 400);
    }
    if (body.allowed_models && body.allowed_models.length > 0) {
      const poolErr = validateAllowedModels(body.allowed_models, body);
      if (poolErr) return c.json({ error: poolErr }, 400);
    }

    // Create company session
    const session = companyStore.createCompanySession({
      template_id: body.template_id,
      name: body.name.trim(),
      config_json: JSON.stringify({
        master_provider: body.master_provider,
        master_model: body.master_model,
        role_assignments: body.role_assignments ?? [],
        // Optional curated pool of models the master can spawn from.
        // Empty/absent = master retains the previous free-form freedom.
        ...(body.allowed_models && body.allowed_models.length > 0
          ? { allowed_models: body.allowed_models }
          : {}),
        // Builder config is persisted inside the free-form config_json so
        // no migration is required. SandboxService reads it back on start.
        ...(body.builder
          ? {
              builder: {
                stack: body.builder.stack,
                ...(body.builder.limits ? { limits: body.builder.limits } : {}),
                ...(body.builder.main_project_id
                  ? { main_project_id: body.builder.main_project_id }
                  : {}),
                ...(body.builder.main_project_runtime
                  ? { main_project_runtime: body.builder.main_project_runtime }
                  : {}),
              },
            }
          : {}),
      }),
    });

    // Link projects (may be the virtual one we just created)
    for (const pid of effectiveProjectIds) {
      companyStore.addProjectToCompanySession(
        session.id,
        pid,
        body.project_labels?.[pid],
      );
    }

    // Seed stack-specific snapshots so the master agent can retrieve
    // current (2026) idiomatic patterns via `query_snapshots`. Failure
    // here MUST NOT break session creation — snapshots are augmentation,
    // not a hard dependency.
    if (body.builder && isBuilderStack(body.builder.stack)) {
      try {
        await stackSnapshotSeeder.seedForSession(effectiveProjectIds, body.builder.stack);
      } catch (err) {
        console.error(
          '[company/sessions] stack-snapshot seeding failed:',
          (err as Error).message,
        );
      }
    }

    return c.json(companyStore.getCompanySessionFull(session.id), 201);
  });

  app.post('/api/company/sessions/:id/projects', async (c) => {
    const sessionId = parseIdParam(c);
    const body = await parseJsonBody<{ project_id: number; label?: string }>(c);
    if (!body.project_id) return c.json({ error: 'project_id required' }, 400);

    const session = companyStore.getCompanySession(sessionId);
    if (!session) return notFound(c);

    const proj = db.getProject(body.project_id);
    if (!proj) return c.json({ error: `Project ${body.project_id} not found` }, 404);

    companyStore.addProjectToCompanySession(sessionId, body.project_id, body.label);
    return c.json({ ok: true });
  });

  /**
   * Remove a project from a session. Behaviour depends on what the
   * link points at:
   *
   *   • Link has a `label` (i.e. it's a microservice's virtual project)
   *     → tear down the whole service: stop the container, wipe the
   *       host workdir, delete the `_builder_*` project row, unlink.
   *       Same path as DELETE /services/:serviceId.
   *
   *   • Link has no label (user-attached real project)
   *     → just unlink. NEVER touch the `projects` row or the disk —
   *       real projects can belong to multiple sessions and are owned
   *       by the user.
   *
   *   • Link is orphaned (project_id no longer exists)
   *     → just drop the dangling link row.
   *
   * Refuses with 409 if this would leave the session with zero
   * projects — the orchestrator assumes at least one.
   */
  app.delete('/api/company/sessions/:id/projects/:projectId', async (c) => {
    const sessionId = parseIdParam(c);
    const projectId = Number(c.req.param('projectId'));
    if (!Number.isFinite(projectId) || projectId <= 0) {
      return c.json({ error: 'projectId must be a positive integer' }, 400);
    }
    const session = companyStore.getCompanySession(sessionId);
    if (!session) return notFound(c);

    const links = companyStore.listCompanySessionProjects(sessionId);
    const link = links.find((p) => p.project_id === projectId);
    if (!link) return c.json({ error: `Project ${projectId} is not linked to this session` }, 404);

    if (links.length <= 1) {
      return c.json(
        { error: 'Cannot remove the last project from a session. Delete the session instead.' },
        409,
      );
    }

    if (link.label) {
      // Microservice — full teardown.
      try {
        await removeServiceAndProject(sessionId, link.label);
      } catch (e) {
        return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
      }
      return c.json({ ok: true });
    }

    // Real project — just unlink.
    try {
      companyStore.removeProjectFromCompanySession(sessionId, projectId);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
    return c.json({ ok: true });
  });

  /**
   * Eagerly provision the builder sandbox for a session. Called by the
   * BuilderView the moment it renders so the container is already
   * scaffolding while the user is still typing their first prompt.
   *
   * Idempotent: a second POST while the sandbox is already
   * provisioning/ready returns the current snapshot without spawning
   * a second container (SandboxManager.provision short-circuits on an
   * existing entry).
   *
   * Returns 409 for sessions that weren't created with `builder.stack`
   * — we never silently upgrade a traditional session into builder mode.
   */
  app.post('/api/company/sessions/:id/sandbox', async (c) => {
    const id = parseIdParam(c);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);

    let stack: ProvisionableStack | null = null;
    // Extract limits alongside stack in a single JSON parse. Without
    // this, the eager-provision endpoint creates the container with
    // process defaults (1g/1/256), and the later idempotent call from
    // `SandboxService.provisionIfNeeded` — which DOES pass limits —
    // short-circuits on the existing sandbox. Net result: user-chosen
    // limits silently ignored.
    let limits: { memory?: string; cpus?: string; pids?: number } | undefined;
    try {
      const cfg = JSON.parse(session.config_json || '{}') as {
      builder?: {
        stack?: string;
        limits?: { memory?: string; cpus?: string; pids?: number };
        main_project_id?: number;
        main_project_runtime?: ExternalProjectRuntime;
      };
      };
      const requested = cfg.builder?.stack;
      // `isProvisionableStack` (vs `isBuilderStack`) — DS sessions use
      // `'node-only'` which is registered as a scaffolder but kept out
      // of the user-facing builder picker. The provision route must
      // accept it so DS sessions can have their container restarted.
      if (isProvisionableStack(requested)) stack = requested;
      if (cfg.builder?.limits) limits = cfg.builder.limits;
    } catch {
      /* treat as non-builder */
    }
    if (!stack) {
      return c.json({ error: 'session was not created with builder mode' }, 409);
    }

    // `?retry=1` (or JSON body `{retry:true}`) forces teardown of an
    // existing errored sandbox before provisioning. The UI's retry
    // button sets this; the normal eager-provision call from the hook
    // omits it so the idempotent fast-path still applies.
    const retry =
      c.req.query('retry') === '1' ||
      (await c.req.json().catch(() => ({}) as { retry?: boolean })).retry === true;

    const manager = getSandboxManager();
    // Resolve the primary project's `root_path` so the sandbox
    // bind-mounts onto the SAME directory the linked virtual project
    // (`_builder_<uuid>`) points at. Microservices use their own
    // service label; the primary is the first linked project without
    // a service_id label (falls back to the first link if all are
    // labeled, which only happens for user-supplied builder projects).
    const cfg = JSON.parse(session.config_json || '{}') as {
      builder?: { main_project_id?: number; main_project_runtime?: ExternalProjectRuntime };
    };
    const mainProjectId = cfg.builder?.main_project_id;
    const linkedProjects = companyStore.listCompanySessionProjects(id);
    const primaryLink =
      mainProjectId != null
        ? linkedProjects.find((p) => p.project_id === mainProjectId)
        : linkedProjects.find((p) => !p.label) ?? linkedProjects[0];
    const primaryProject = primaryLink ? db.getProject(primaryLink.project_id) : null;
    const hostWorkdirMount = primaryProject?.root_path ?? undefined;
    let externalSpec:
      | ReturnType<typeof resolveExternalProjectSpec>
      | {};
    if (mainProjectId != null) {
      if (!primaryProject) return c.json({ error: `Project ${mainProjectId} not found` }, 404);
      try {
        externalSpec = resolveExternalProjectSpec(
          primaryProject.root_path,
          stack as BuilderStack,
          cfg.builder?.main_project_runtime,
        );
      } catch (e) {
        return c.json(
          {
            error: e instanceof Error ? e.message : String(e),
          },
          400,
        );
      }
    } else {
      externalSpec = {};
    }
    try {
      // Fire-and-await: the provision returns once the dev server
      // binds its port. We keep the HTTP roundtrip open because the
      // frontend's poll-driven UX assumes the side-effect is done
      // (or at least provably started) by the time this returns.
      const sandbox = await manager.provision({
        sessionId: String(id),
        stack,
        retry,
        limits,
        hostWorkdirMount,
        ...externalSpec,
      });
      return c.json({
        status: sandbox.status,
        step: sandbox.step,
        previewUrl: sandbox.previewUrl,
        stack: sandbox.stack,
        hostPort: sandbox.hostPort,
      });
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : String(e) },
        500,
      );
    }
  });

  /**
   * Kill and relaunch the dev server inside a running sandbox WITHOUT
   * destroying the container. Used by the PreviewPanel's "Restart
   * dev-server" button when the iframe shows ECONNREFUSED but the
   * container is still alive (typical cause: agent overwrote
   * `vite.config.ts` with a default template and lost `server.host`
   * / `usePolling` / `base`).
   *
   * Preserves: container, installed node_modules, user-written source,
   * host port.
   * Resets: vite.config.ts (to the canonical proxy-aware template),
   * running Vite process.
   */
  app.post('/api/company/sessions/:id/sandbox/restart-dev', async (c) => {
    const id = parseIdParam(c);
    const sandbox = getSandboxManager().get(String(id));
    if (!sandbox) return c.json({ error: 'sandbox not running' }, 404);
    try {
      await getSandboxManager().restartDevServer(String(id));
      return c.json({ ok: true, previewUrl: sandbox.previewUrl });
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : String(e) },
        500,
      );
    }
  });

  app.post('/api/company/sessions/:id/services/:serviceId/pause', async (c) => {
    const id = parseIdParam(c);
    const serviceId = c.req.param('serviceId');
    if (!serviceId) return c.json({ error: 'serviceId required' }, 400);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);
    const blocked = rejectIfAttached(id, serviceId);
    if (blocked) return c.json({ error: blocked.error }, blocked.status);
    try {
      const sb = await getSandboxManager().pauseRuntimeContainer(String(id), serviceId);
      return c.json({
        ok: true,
        service_id: serviceId,
        status: sb.runtimePaused ? 'paused' : sb.status,
        runtime_paused: !!sb.runtimePaused,
        preview_url: sb.previewUrl,
        container_id: sb.containerId,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const status: 404 | 409 | 500 = /No sandbox|No service|no longer exists/i.test(message)
        ? 404
        : /Cannot|not running/i.test(message)
          ? 409
          : 500;
      return c.json({ error: message }, status);
    }
  });

  app.post('/api/company/sessions/:id/services/:serviceId/unpause', async (c) => {
    const id = parseIdParam(c);
    const serviceId = c.req.param('serviceId');
    if (!serviceId) return c.json({ error: 'serviceId required' }, 400);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);
    const blocked = rejectIfAttached(id, serviceId);
    if (blocked) return c.json({ error: blocked.error }, blocked.status);
    try {
      const sb = await getSandboxManager().unpauseRuntimeContainer(String(id), serviceId);
      return c.json({
        ok: true,
        service_id: serviceId,
        status: sb.runtimePaused ? 'paused' : sb.status,
        runtime_paused: !!sb.runtimePaused,
        preview_url: sb.previewUrl,
        container_id: sb.containerId,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const status: 404 | 409 | 500 = /No sandbox|No service|no longer exists/i.test(message)
        ? 404
        : /Cannot|not running/i.test(message)
          ? 409
          : 500;
      return c.json({ error: message }, status);
    }
  });

  /**
   * Tail the dev-server log inside a running sandbox container.
   * Convenience endpoint for debugging "why isn't my preview
   * working?" — the scaffolder redirects `npm run dev` stdout+stderr
   * to `/tmp/dev-server.log` inside the container; this exposes the
   * last N lines so operators can see Vite's own output (compile
   * errors, port-bind failures, etc) without shelling into podman.
   *
   * Query: `?lines=200` (default 200, max 2000)
   */
  app.get('/api/company/sessions/:id/services/:serviceId/logs', async (c) => {
    const id = parseIdParam(c);
    const serviceId = c.req.param('serviceId');
    if (!serviceId) return c.json({ error: 'serviceId required' }, 400);
    const svc = getSandboxManager().getService(String(id), serviceId);
    if (!svc || !svc.containerId) {
      return c.json({ error: `service '${serviceId}' not running` }, 404);
    }
    if (svc.runtimePaused) {
      return c.json({ error: `service '${serviceId}' is runtime-paused` }, 409);
    }
    const requested = Number(c.req.query('lines') ?? '200');
    const lines = Number.isFinite(requested) ? Math.min(Math.max(requested, 10), 2_000) : 200;
    const { resolveDriver } = await import('@mcp/services/sandbox/index.js');
    const driver = await resolveDriver();
    if (svc.imageSource === 'project_dockerfile') {
      const logs = await driver.getContainerLogs(svc.containerId, lines).catch(() => '');
      return c.json({
        devServer: logs,
        containerId: svc.containerId,
        hostPort: svc.hostPort,
        portStatus: (await driver.isPortListening(svc.hostPort)) ? 'listening' : 'not-listening',
        scaffolder: svc.recentLogs,
      });
    }
    const res = await driver.exec(
      svc.containerId,
      `tail -n ${lines} /tmp/dev-server.log 2>/dev/null || true`,
      { cwd: undefined, timeoutMs: 5_000 },
    );
    // Also probe port readiness so the user sees whether the dev
    // server is actually up (useful when fetch failed).
    const portProbe = await driver.exec(
      svc.containerId,
      `ss -ltn 2>/dev/null | awk '{print $4}' | grep -E ':${svc.containerPort}$' >/dev/null && echo listening || echo not-listening`,
      { cwd: undefined, timeoutMs: 2_000 },
    );
    return c.json({
      devServer: res.stdout,
      containerId: svc.containerId,
      hostPort: svc.hostPort,
      portStatus: portProbe.stdout.trim(),
      scaffolder: svc.recentLogs,
    });
  });

  // Restart dev-server inside a service container — kills the node/
  // wrangler process and relaunches with the scaffolder's original
  // command. Used when the dev server died but the container stayed.
  app.post('/api/company/sessions/:id/services/:serviceId/restart-dev', async (c) => {
    const id = parseIdParam(c);
    const serviceId = c.req.param('serviceId');
    if (!serviceId) return c.json({ error: 'serviceId required' }, 400);
    const blocked = rejectIfAttached(id, serviceId);
    if (blocked) return c.json({ error: blocked.error }, blocked.status);
    const svc = getSandboxManager().getService(String(id), serviceId);
    if (!svc || !svc.containerId) {
      return c.json({ error: `service '${serviceId}' not running` }, 404);
    }
    if (svc.runtimePaused) {
      return c.json({ error: `service '${serviceId}' is runtime-paused` }, 409);
    }
    if (svc.mountKind === 'external') {
      return c.json(
        {
          error:
            'External project containers should be recreated with Retry so package.json/Dockerfile metadata is re-read.',
        },
        409,
      );
    }
    if (svc.imageSource === 'project_dockerfile') {
      return c.json(
        {
          error:
            'Project Dockerfile containers use their image CMD/ENTRYPOINT; use Retry to rebuild/recreate.',
        },
        409,
      );
    }
    const { resolveDriver } = await import('@mcp/services/sandbox/index.js');
    const driver = await resolveDriver();

    // Kill anything bound to the dev port / likely dev-server process.
    await driver.exec(
      svc.containerId,
      `pkill -f 'wrangler|vite|node' 2>/dev/null || true`,
      { cwd: undefined, timeoutMs: 5_000 },
    );

    // Relaunch the command by stack. Kept in the route rather than
    // the manager to avoid duplicating scaffolder-internal knowledge
    // in too many places for this recovery-only path.
    let cmd: string;
    if (svc.stack === 'cf-worker') {
      cmd =
        `nohup npx wrangler dev --ip 0.0.0.0 --port 5173 --local ` +
        `--show-interactive-dev-session=false > /tmp/dev-server.log 2>&1 &`;
    } else {
      cmd = `nohup npm run dev -- --host 0.0.0.0 --port 5173 > /tmp/dev-server.log 2>&1 &`;
    }
    const spawnRes = await driver.exec(svc.containerId, cmd, {
      cwd: svc.workdir,
      timeoutMs: 10_000,
    });
    if (spawnRes.exitCode !== 0) {
      return c.json(
        { error: `failed to relaunch dev-server: ${spawnRes.stderr || spawnRes.stdout}` },
        500,
      );
    }
    return c.json({ ok: true });
  });

  app.post('/api/company/sessions/:id/services/:serviceId/start', async (c) => {
    const id = parseIdParam(c);
    const serviceId = c.req.param('serviceId');
    if (!serviceId) return c.json({ error: 'serviceId required' }, 400);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);
    const blocked = rejectIfAttached(id, serviceId);
    if (blocked) return c.json({ error: blocked.error }, blocked.status);

    if (serviceId === 'main') {
      const result = await startPrimarySandboxForSession(id, false);
      if (!result.ok) return c.json({ error: result.error }, result.status);
      return c.json(serviceStartPayload('main', result.sandbox));
    }

    const manager = getSandboxManager();
    await manager.reconcileServiceFromDb(String(id), serviceId).catch(() => void 0);
    const live = manager.getService(String(id), serviceId);
    if (live && live.status !== 'error') {
      try {
        const sb = live.runtimePaused
          ? await manager.unpauseRuntimeContainer(String(id), serviceId)
          : live.status === 'paused'
            ? await manager.startServiceContainer(String(id), serviceId)
            : live;
        return c.json(serviceStartPayload(serviceId, sb));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (!/no longer exists/i.test(message)) {
          return c.json({ error: message }, 409);
        }
        // Fall through to recreate from the saved row/project below.
      }
    }

    interface StartBody {
      stack?: string;
      name?: string;
      limits?: { memory?: string; cpus?: string; pids?: number };
    }
    const body = await parseJsonBody<StartBody>(c).catch(() => null);
    const row = deps.companySandboxServicesStore.get(id, serviceId);

    let resolvedStack: string;
    let resolvedName: string;
    let limits: { memory?: string; cpus?: string; pids?: number } = {};
    let hostWorkdirMount: string | undefined;
    let provisionSpec:
      | ReturnType<typeof resolveExternalProjectSpec>
      | {};
    let forceRecreate = live?.status === 'error';

    if (row) {
      resolvedStack = row.stack;
      resolvedName = row.name || row.service_id;
      try {
        limits = JSON.parse(row.limits_json) as typeof limits;
      } catch { /* ignore malformed limits */ }
      hostWorkdirMount = row.host_workdir_mount || undefined;
      try {
        const link = companyStore
          .listCompanySessionProjects(id)
          .find((p) => p.label === row.service_id);
        if (link) {
          const proj = db.getProject(link.project_id);
          if (proj?.root_path) hostWorkdirMount = proj.root_path;
        }
      } catch { /* fall back to row.host_workdir_mount */ }
      if (row.mount_kind === 'external') {
        try {
          if (row.image_source === 'project_dockerfile') {
            if (!row.dockerfile_path || !row.dockerfile_exposed_port) {
              throw new Error(
                'External Dockerfile service is missing Dockerfile metadata. Re-add it from the External project tab.',
              );
            }
            provisionSpec = {
              mountKind: 'external',
              imageSource: 'project_dockerfile',
              dockerfilePath: row.dockerfile_path,
              containerPortOverride: row.dockerfile_exposed_port,
              skipDefaultCommand: true,
            };
          } else if (hostWorkdirMount) {
            provisionSpec = resolveExternalProjectSpec(
              hostWorkdirMount,
              row.stack as BuilderStack,
              'node',
            );
          } else {
            throw new Error('External Node service is missing its project root.');
          }
        } catch (e) {
          return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      } else {
        provisionSpec = {};
      }
    } else {
      const link = companyStore
        .listCompanySessionProjects(id)
        .find((p) => p.label === serviceId);
      if (!link) {
        return c.json({ error: `Service '${serviceId}' not found` }, 404);
      }
      const stack = body?.stack?.trim();
      if (!stack) {
        return c.json(
          {
            error:
              `Service '${serviceId}' has no saved stack. Pass { "stack": "<react-ts|vue-ts|vite-api|cf-worker|...>" } to start it.`,
          },
          400,
        );
      }
      const proj = db.getProject(link.project_id);
      resolvedStack = stack;
      resolvedName = body?.name ?? proj?.name ?? serviceId;
      if (body?.limits) limits = body.limits;
      hostWorkdirMount = proj?.root_path ?? undefined;
      if (proj && !proj.name.startsWith('_builder_')) {
        try {
          provisionSpec = resolveExternalProjectSpec(proj.root_path, stack as BuilderStack);
        } catch (e) {
          return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      } else {
        provisionSpec = {};
      }
    }

    try {
      const sandbox = await manager.provisionAdditionalService({
        sessionId: String(id),
        serviceId,
        stack: resolvedStack as BuilderStack,
        name: resolvedName,
        limits,
        hostWorkdirMount,
        forceRecreate,
        ...provisionSpec,
      });
      return c.json(serviceStartPayload(serviceId, sandbox));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  app.get('/api/company/sessions/:id/sandbox/logs', async (c) => {
    const id = parseIdParam(c);
    const sandbox = getSandboxManager().get(String(id));
    if (!sandbox || !sandbox.containerId) {
      return c.json({ error: 'sandbox not running' }, 404);
    }
    // Watching the dev-server log counts as activity too.
    getSandboxManager().touch(String(id));
    const requested = Number(c.req.query('lines') ?? '200');
    const lines = Number.isFinite(requested) ? Math.min(Math.max(requested, 10), 2_000) : 200;
    // Best-effort: if the file doesn't exist yet (dev-server still
    // spinning up) we return an empty string rather than a 500.
    const { resolveDriver } = await import('@mcp/services/sandbox/index.js');
    const driver = await resolveDriver();
    const res = await driver.exec(
      sandbox.containerId,
      `tail -n ${lines} /tmp/dev-server.log 2>/dev/null || true`,
      { cwd: undefined, timeoutMs: 5_000 },
    );
    return c.json({
      devServer: res.stdout,
      containerId: sandbox.containerId,
      hostPort: sandbox.hostPort,
      // The `recentLogs` ring buffer also carries scaffolder-level
      // lines. Surface them alongside so the UI has everything on
      // one request.
      scaffolder: sandbox.recentLogs,
    });
  });

  /**
   * Builder-mode status poll. Returns the sandbox state (if any) plus
   * the persisted `builder.stack` selection so the dashboard knows
   * whether to render the BuilderView or the traditional layout.
   *
   * Designed for lightweight polling: the payload is tiny and the
   * handler reads purely from in-memory state (no DB hit beyond the
   * initial session lookup).
   */
  app.get('/api/company/sessions/:id/sandbox', (c) => {
    const id = parseIdParam(c);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);
    let stack: ProvisionableStack | null = null;
    try {
      const cfg = JSON.parse(session.config_json || '{}') as { builder?: { stack?: string } };
      const requested = cfg.builder?.stack;
      if (isProvisionableStack(requested)) stack = requested;
    } catch {
      // Legacy sessions have arbitrary config_json — treat as non-builder.
    }
    const sandbox = getSandboxManager().get(String(id));
    // Treat an active poll from the dashboard as "the user is watching
    // this session" — bump the idle timer so the reaper doesn't kill
    // a live-but-silent sandbox out from under an open browser tab.
    // Without this, sandboxes died after 30 min even with the preview
    // iframe visible, because HMR is all-WebSocket after the initial
    // load and the WS upgrade only touches once.
    if (sandbox) getSandboxManager().touch(String(id));

    // Mint a rolling preview cookie whenever the session polls status.
    // The browser refreshes it every ~1s while provisioning and every
    // ~10s once ready, so the sliding 30-min TTL is in practice always
    // fresh for an active user — idle tabs naturally lose access.
    const response = c.json({
      builder: stack ? { stack } : null,
      sandbox: sandbox
        ? {
            status: sandbox.status,
            runtimePaused: !!sandbox.runtimePaused,
            step: sandbox.step,
            previewUrl: sandbox.previewUrl,
            stack: sandbox.stack,
            error: sandbox.error ?? null,
            hostPort: sandbox.hostPort,
            createdAt: sandbox.createdAt,
            // Tail of the ring buffer so the preview pane can show a
            // live log without opening a second stream. Cap at 50 lines
            // here (the manager keeps up to 200) to keep each poll
            // response small even during a noisy npm install.
            recentLogs: sandbox.recentLogs.slice(-50),
            // Exposed solely so the "View dev-server logs" button in
            // the UI knows whether a container is live enough to
            // have a log to tail. Not sensitive — it's a random sha256.
            containerId: sandbox.containerId || undefined,
            // Resolved limits the container was actually created with
            // (session override merged with env defaults). UI displays
            // this so users know "am I on 512m or 2g?" at a glance.
            limits: sandbox.limits,
          }
        : null,
    });
    if (stack) {
      const token = mintPreviewToken(String(id));
      const secure = (c.req.header('x-forwarded-proto') ?? '').toLowerCase() === 'https';
      response.headers.append('Set-Cookie', formatSetCookie(token, { secure }));
    }
    return response;
  });

  // ─── Shared env vars ────────────────────────────────────────────
  //
  // Session-scoped key/value store injected into every container
  // (primary + services) at provision time and materialized as
  // `/app/.env` so live dev-servers pick up edits without restart.
  //
  // Secret values are masked in the default list response; pass
  // `?reveal=1` (authenticated operators only — the token/bearer layer
  // already gates the route) to include plaintext values.

  const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

  app.get('/api/company/sessions/:id/envs', (c) => {
    const id = parseIdParam(c);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);
    const reveal = c.req.query('reveal') === '1';
    const rows = deps.companySessionEnvStore.list(id);
    return c.json({
      envs: rows.map((r) => ({
        key: r.key,
        value: r.is_secret && !reveal ? '' : r.value,
        is_secret: !!r.is_secret,
        masked: !!r.is_secret && !reveal,
        source: r.source ?? 'user',
        updated_at: r.updated_at,
      })),
    });
  });

  app.put('/api/company/sessions/:id/envs/:key', async (c) => {
    const id = parseIdParam(c);
    const key = c.req.param('key');
    if (!key || !KEY_RE.test(key)) {
      return c.json({ error: `Invalid key '${key}'. Use letters/digits/underscore only.` }, 400);
    }
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);
    const body = await parseJsonBody<{ value?: string; is_secret?: boolean }>(c);
    if (!body || typeof body.value !== 'string') {
      return c.json({ error: 'value (string) required' }, 400);
    }
    deps.companySessionEnvStore.upsert(id, key, body.value, !!body.is_secret);
    // Push the new .env to any live container so running dev-servers
    // pick up the change without a reprovision. Best-effort — the
    // truthful state is always the DB; live sync is a nicety.
    await getSandboxManager()
      .syncEnvsToAllContainers(String(id))
      .catch(() => void 0);
    return c.json({ ok: true });
  });

  app.delete('/api/company/sessions/:id/envs/:key', async (c) => {
    const id = parseIdParam(c);
    const key = c.req.param('key');
    if (!key) return c.json({ error: 'key required' }, 400);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);
    deps.companySessionEnvStore.delete(id, key);
    await getSandboxManager()
      .syncEnvsToAllContainers(String(id))
      .catch(() => void 0);
    return c.json({ ok: true });
  });

  // ─── Session config patch ───────────────────────────────────────
  //
  // Lets the UI edit a session's agent configuration post-creation
  // without tearing the session down. Three orthogonal facets are
  // supported, each optional:
  //   - role_assignments: new (provider, model, tier, skills) per role
  //   - skills: per-role skill override maps
  //   - allowed_models: curated pool the master may spawn from
  //
  // The patch is persisted to `company_sessions.config_json` and —
  // when the session is running — propagated via the orchestrator so
  // live agents see the change on their next cycle.

  app.patch('/api/company/sessions/:id/config', async (c) => {
    const id = parseIdParam(c);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);

    interface ConfigPatchBody {
      role_assignments?: Array<{
        role: string;
        provider: string;
        model: string;
        tier?: string;
        projectHints?: string[];
        /**
         * Concrete project ids this role is bound to in this session.
         * Validated against the session's linked projects; ids outside
         * the session are rejected to prevent phantom bindings that
         * would later make `spawn_subordinate_agent` unreachable.
         */
        projectIds?: number[];
        skills?: string[];
        systemPromptOverride?: string;
      }>;
      skills?: Record<string, string[]>;
      allowed_models?: Array<{
        provider: string;
        model: string;
        label?: string;
        notes?: string;
        is_default?: boolean;
      }>;
    }
    const body = await parseJsonBody<ConfigPatchBody>(c);
    if (!body) return c.json({ error: 'Invalid body' }, 400);

    // Basic validation: every role_assignment entry must carry
    // role/provider/model. Deeper validation (model exists in provider,
    // skill ids resolve, etc.) is shared with session creation — for
    // now we accept the patch and let the orchestrator reject at
    // update-time if anything is malformed.
    if (body.role_assignments) {
      for (const r of body.role_assignments) {
        if (!r.role || !r.provider || !r.model) {
          return c.json({ error: 'role_assignments entries need role, provider, model' }, 400);
        }
      }
      // projectIds must reference projects that are actually linked to
      // this session — otherwise the binding is unreachable (the master
      // would see it in its prompt but spawn_subordinate_agent would
      // reject because the id isn't in `ctx.projects`).
      if (body.role_assignments.some((r) => Array.isArray(r.projectIds) && r.projectIds.length > 0)) {
        const linked = new Set(
          companyStore.listCompanySessionProjects(id).map((p) => p.project_id),
        );
        for (const r of body.role_assignments) {
          if (!Array.isArray(r.projectIds)) continue;
          const bad = r.projectIds.filter((pid) => !linked.has(pid));
          if (bad.length > 0) {
            return c.json(
              {
                error: `role '${r.role}' has projectIds not linked to this session: [${bad.join(', ')}]. ` +
                  `Valid ids: [${Array.from(linked).join(', ')}]`,
              },
              400,
            );
          }
        }
      }
    }

    const orch = orchestratorRegistry.get(id);
    if (orch) {
      try {
        orch.applyConfigPatch({
          role_assignments: body.role_assignments?.map((r) => ({
            role: r.role,
            provider: r.provider,
            model: r.model,
            tier: r.tier ?? 'navigate',
            projectHints: r.projectHints,
            projectIds: r.projectIds,
            skills: r.skills,
            systemPromptOverride: r.systemPromptOverride,
          })),
          skills: body.skills,
          allowed_models: body.allowed_models,
        });
      } catch (e) {
        return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
    } else {
      // Session not running — persist directly so the change survives
      // to the next `startMaster` call.
      let cfg: Record<string, unknown> = {};
      try { cfg = JSON.parse(session.config_json || '{}'); } catch { cfg = {}; }
      if (body.role_assignments) cfg.role_assignments = body.role_assignments;
      if (body.skills) cfg.skills = body.skills;
      if (body.allowed_models) cfg.allowed_models = body.allowed_models;
      companyStore.updateCompanySessionConfig(id, JSON.stringify(cfg));
    }
    return c.json({ ok: true });
  });

  // ─── Docs read-only proxy ────────────────────────────────────────
  //
  // The dashboard's Docs tab fetches markdown files produced by the
  // agents' `docs_*` tools. Routes are read-only on purpose: every
  // write MUST go through the agent tools (so the agents stay the
  // source of truth), but the UI also lets users trigger a "please
  // document X" prompt which is a regular chat message, not a REST call.
  //
  // Path validation: we strip any `..`, absolute prefix, or embedded
  // NUL before joining with `<workdir>/docs/`. A bad path 400s.

  function resolveDocsBinding(
    sessionId: number,
    serviceId: string | null,
  ):
    | { workdir: string; containerId: string; driver: ReturnType<typeof getSandboxManager>['get'] extends (...a: unknown[]) => infer _ ? unknown : never }
    | null {
    const manager = getSandboxManager();
    if (serviceId) {
      const sb = manager.getService(String(sessionId), serviceId);
      if (!sb) return null;
      return {
        workdir: sb.workdir,
        containerId: sb.containerId,
        // `driver` is resolved per-use via the manager's driver cache;
        // the helper below goes through the manager's driver singleton.
      } as unknown as never;
    }
    const primary = manager.get(String(sessionId));
    if (!primary) return null;
    return {
      workdir: primary.workdir,
      containerId: primary.containerId,
    } as unknown as never;
  }

  app.get('/api/company/sessions/:id/docs/list', async (c) => {
    const id = parseIdParam(c);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);
    const serviceId = c.req.query('service') || null;
    const binding = resolveDocsBinding(id, serviceId);
    if (!binding) return c.json({ error: 'No sandbox' }, 404);
    const { resolveDriver } = await import('@mcp/services/sandbox/drivers/driver-factory.js');
    const driver = await resolveDriver();
    const probe = await driver.exec(
      (binding as unknown as { containerId: string }).containerId,
      `cd ${(binding as unknown as { workdir: string }).workdir}/docs 2>/dev/null && find . -type f \\( -name '*.md' -o -name 'index.json' \\) 2>/dev/null | sed 's|^\\./||' || true`,
      { cwd: (binding as unknown as { workdir: string }).workdir, timeoutMs: 5_000 },
    );
    const items = probe.stdout.split('\n').map((s) => s.trim()).filter(Boolean).sort();
    return c.json({ items });
  });

  app.get('/api/company/sessions/:id/docs/read', async (c) => {
    const id = parseIdParam(c);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);
    const serviceId = c.req.query('service') || null;
    const path = c.req.query('path') || '';
    if (!path || path.includes('..') || path.startsWith('/') || path.includes('\0')) {
      return c.json({ error: 'invalid path' }, 400);
    }
    const binding = resolveDocsBinding(id, serviceId);
    if (!binding) return c.json({ error: 'No sandbox' }, 404);
    const { resolveDriver } = await import('@mcp/services/sandbox/drivers/driver-factory.js');
    const driver = await resolveDriver();
    try {
      const abs = `${(binding as unknown as { workdir: string }).workdir}/docs/${path}`;
      const text = await driver.readFile(
        (binding as unknown as { containerId: string }).containerId,
        abs,
      );
      return c.text(text);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 404);
    }
  });

  // ─── Multi-service sandbox (migration 035) ───────────────────────
  //
  // A session can host N microservice containers beyond its primary
  // sandbox. Listing merges persisted rows with the in-memory manager
  // state so callers see provisioning progress without a second
  // stream. Adding / removing goes through the orchestrator's
  // SandboxService so the metaBus gets `sandbox.service.*` events.

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
      return {
        service_id: row.service_id,
        name: row.name || row.service_id,
        stack: row.stack,
        status: isOrphaned ? 'paused' : liveStatus,
        runtime_paused: runtimePaused,
        step: liveSb?.step ?? 'queued',
        host_port: row.host_port,
        preview_url: liveSb?.previewUrl ?? null,
        is_primary: !!row.is_primary,
        error: liveSb?.error ?? row.error ?? (isOrphaned && !isAttached ? 'Container is not present. Press Play to recreate it.' : null),
        created_at: row.created_at,
        mount_kind: row.mount_kind ?? 'owned',
        image_source: row.image_source ?? 'default',
        is_attached: isAttached,
        external_container_ref: row.external_container_ref ?? null,
        attached_hostname: row.attached_hostname ?? null,
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
      let builderStack = '';
      try {
        const cfg = JSON.parse(session.config_json || '{}') as { builder?: { stack?: string } };
        if (isProvisionableStack(cfg.builder?.stack)) builderStack = cfg.builder.stack;
      } catch {
        /* non-builder */
      }
      if (sandboxRow || liveMain || builderStack) {
        const runtimePaused = !!liveMain?.runtimePaused;
        services.unshift({
          service_id: 'main',
          name: 'main',
          stack: liveMain?.stack ?? sandboxRow?.stack ?? builderStack,
          status: runtimePaused ? 'paused' : liveMain?.status ?? sandboxRow?.status ?? 'paused',
          runtime_paused: runtimePaused,
          step: liveMain?.step ?? 'queued',
          host_port: liveMain?.hostPort ?? sandboxRow?.host_port ?? 0,
          preview_url: liveMain?.previewUrl ?? null,
          is_primary: true,
          error: liveMain?.error ?? sandboxRow?.error ?? null,
          created_at: sandboxRow?.created_at ?? new Date().toISOString(),
          mount_kind: liveMain?.mountKind ?? sandboxRow?.mount_kind ?? 'owned',
          image_source: liveMain?.imageSource ?? sandboxRow?.image_source ?? 'default',
          is_attached: false,
          external_container_ref: null,
          attached_hostname: null,
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
    };
    const augmented: SidecarService[] = services.slice();
    for (const link of companyStore.listCompanySessionProjects(id)) {
      if (!link.label) continue;
      if (seen.has(link.label)) continue;
      const project = db.getProject(link.project_id);
      augmented.push({
        service_id: link.label,
        name: project?.name ?? link.label,
        stack: '',
        status: 'paused',
        runtime_paused: false,
        step: 'queued',
        host_port: 0,
        preview_url: null,
        is_primary: false,
        error:
          'Service container is gone but project files are intact. Click Retry to re-provision.',
        created_at: new Date().toISOString(),
        project_id: link.project_id,
        root_path: project?.root_path ?? '',
        mount_kind: project?.name?.startsWith('_builder_') ? 'owned' : 'external',
        image_source: 'default',
        is_attached: false,
        external_container_ref: null,
        attached_hostname: null,
      });
      seen.add(link.label);
    }

    return c.json({ services: augmented });
  });

  // ─── OpenAPI document for the API Reference tab ─────────────────
  //
  // Probes a fixed set of conventional paths inside the service's
  // workdir and returns the first one that parses. Read goes through
  // the sandbox driver so it works for both OCI (local bind-mount) and
  // E2B (remote workdir). Returning JSON from a YAML source means the
  // dashboard's renderer (Scalar) doesn't need a YAML parser.

  const OPENAPI_CANDIDATES: ReadonlyArray<string> = [
    'openapi.yaml',
    'openapi.yml',
    'openapi.json',
    'docs/openapi.yaml',
    'docs/openapi.yml',
    'docs/openapi.json',
    'api/openapi.yaml',
    'api/openapi.yml',
    'api/openapi.json',
  ];

  app.get('/api/company/sessions/:id/services/:serviceId/openapi', async (c) => {
    const id = parseIdParam(c);
    const serviceId = c.req.param('serviceId');
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);

    const manager = getSandboxManager();
    const sb =
      serviceId === 'main'
        ? manager.get(String(id))
        : manager.getService(String(id), serviceId);
    if (!sb) {
      return c.json(
        { error: 'service_not_running', searchedPaths: [] },
        404,
      );
    }

    const { resolveDriver } = await import('@mcp/services/sandbox/drivers/driver-factory.js');
    const driver = await resolveDriver();

    const tried: string[] = [];
    for (const rel of OPENAPI_CANDIDATES) {
      const abs = `${sb.workdir.replace(/\/+$/, '')}/${rel}`;
      tried.push(rel);
      let raw: string;
      try {
        raw = await driver.readFile(sb.containerId, abs);
      } catch {
        continue;
      }
      try {
        const spec = rel.endsWith('.json') ? JSON.parse(raw) : (await parseOpenApiYaml(raw));
        return c.json({ spec, sourcePath: rel });
      } catch (e) {
        return c.json(
          {
            error: 'spec_parse_error',
            sourcePath: rel,
            message: e instanceof Error ? e.message : String(e),
          },
          422,
        );
      }
    }
    return c.json({ error: 'openapi_not_found', searchedPaths: tried }, 404);
  });

  app.post('/api/company/sessions/:id/services', async (c) => {
    const id = parseIdParam(c);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);

    interface AddServiceBody {
      service_id: string;
      stack: string;
      name?: string;
      limits?: { memory?: string; cpus?: string; pids?: number };
      source?: { project_id?: number; runtime?: ExternalProjectRuntime };
    }
    const body = await parseJsonBody<AddServiceBody>(c);
    if (!body || typeof body.service_id !== 'string' || typeof body.stack !== 'string') {
      return c.json({ error: 'service_id and stack are required' }, 400);
    }

    // Resolve effective limits for the new container. Precedence:
    //   1. Explicit `body.limits` (user override in the Add Service form)
    //   2. The session's primary sandbox limits (builder.limits from
    //      config_json) — the "same as the company" inheritance users
    //      expect when they don't touch the limits inputs.
    //   3. Process-wide MCP_SANDBOX_* defaults, applied deep in the
    //      manager via DEFAULT_SANDBOX_LIMITS.
    // Only step 2 is new here; step 3 fires automatically downstream.
    let effectiveLimits: typeof body.limits = body.limits;
    if (!effectiveLimits) {
      try {
        const cfg = JSON.parse(session.config_json || '{}') as {
          builder?: { limits?: { memory?: string; cpus?: string; pids?: number } };
        };
        if (cfg.builder?.limits) effectiveLimits = cfg.builder.limits;
      } catch {
        /* empty or malformed config_json — skip inheritance */
      }
    }

    const externalProjectId = body.source?.project_id;
    const externalProject =
      Number.isInteger(externalProjectId) && externalProjectId! > 0
        ? db.getProject(externalProjectId!)
        : null;
    if (body.source) {
      if (!externalProject) {
        return c.json({ error: `Project ${externalProjectId} not found` }, 404);
      }
      if (body.source.runtime !== undefined && !isExternalProjectRuntime(body.source.runtime)) {
        return c.json({ error: "source.runtime must be 'dockerfile' or 'node'" }, 400);
      }
    }

    let provisionSpec:
      | ReturnType<typeof resolveExternalProjectSpec>
      | {};
    try {
      provisionSpec = externalProject
        ? resolveExternalProjectSpec(
            externalProject.root_path,
            body.stack as BuilderStack,
            body.source?.runtime,
          )
        : {};
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }

    let projectId: number;
    let rootPath: string;
    let createdOwnedProject = false;
    try {
      if (externalProject) {
        projectId = externalProject.id;
        rootPath = externalProject.root_path;
      } else {
        const uuid = randomUUID();
        rootPath = join(process.cwd(), 'data', 'virtual-projects', uuid);
        mkdirSync(rootPath, { recursive: true });
        const created = db.createProject(
          `_builder_${uuid}`,
          rootPath,
          `Microservice '${body.name || body.service_id}' (${body.stack}) of session #${id}`,
        );
        projectId = created.id;
        createdOwnedProject = true;
      }
      companyStore.addProjectToCompanySession(id, projectId, body.service_id);
    } catch (e) {
      return c.json(
        {
          error: `Failed to prepare project for service: ${e instanceof Error ? e.message : String(e)}`,
        },
        500,
      );
    }

    const orch = orchestratorRegistry.get(id);
    try {
      if (orch) {
        const binding = await orch.sandboxService.addService({
          serviceId: body.service_id,
          stack: body.stack as BuilderStack,
          name: body.name,
          limits: effectiveLimits,
          hostWorkdirMount: rootPath,
          ...provisionSpec,
        });
        return c.json(
          {
            service_id: body.service_id,
            project_id: projectId,
            root_path: rootPath,
            preview_url: binding.previewUrl,
            container_id: binding.containerId,
          },
          201,
        );
      }
      const sandbox = await getSandboxManager().provisionAdditionalService({
        sessionId: String(id),
        serviceId: body.service_id,
        stack: body.stack as BuilderStack,
        name: body.name,
        limits: effectiveLimits,
        hostWorkdirMount: rootPath,
        ...provisionSpec,
      });
      return c.json(
        {
          service_id: body.service_id,
          project_id: projectId,
          root_path: rootPath,
          preview_url: sandbox.previewUrl,
          container_id: sandbox.containerId,
        },
        201,
      );
    } catch (e) {
      // Rollback: unlink FIRST (no FK cascade toward projects means a
      // bare deleteProject would leave an orphan row that the UI
      // renders as `project-<id>` in the sidebar forever), then drop
      // the project row and wipe the empty workdir we just mkdirSync'd.
      try { companyStore.removeProjectFromCompanySession(id, projectId); } catch { /* best effort */ }
      if (createdOwnedProject) {
        try { db.deleteProject(projectId); } catch { /* best effort */ }
        try { await rm(rootPath, { recursive: true, force: true }); } catch { /* best effort */ }
      }
      const message = e instanceof Error ? e.message : String(e);
      return c.json({ error: message }, 400);
    }
  });

  app.post('/api/company/sessions/:id/services/attach', async (c) => {
    const id = parseIdParam(c);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);

    interface AttachBody {
      service_id?: string;
      container_ref?: string;
      name?: string;
      hostname?: string;
    }
    const body = await parseJsonBody<AttachBody>(c);
    const serviceId = (body.service_id ?? '').trim();
    const containerRef = (body.container_ref ?? '').trim();
    if (!serviceId || !containerRef) {
      return c.json({ error: 'service_id and container_ref are required' }, 400);
    }
    const existing = deps.companySandboxServicesStore.get(id, serviceId);
    if (existing && existing.status !== 'destroyed') {
      return c.json({ error: `service '${serviceId}' already exists in this session` }, 409);
    }
    try {
      const sandbox = await getSandboxManager().attachExternalService({
        sessionId: String(id),
        serviceId,
        containerRef,
        name: body.name,
        hostname: body.hostname,
      });
      return c.json(
        {
          service_id: serviceId,
          container_id: sandbox.containerId,
          hostname: sandbox.attachedHostname ?? serviceId,
          status: sandbox.runtimePaused ? 'paused' : sandbox.status,
          runtime_paused: !!sandbox.runtimePaused,
          error: sandbox.error ?? null,
        },
        201,
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const status = /not found/i.test(message) ? 404 : 400;
      return c.json({ error: message }, status);
    }
  });

  app.post('/api/company/sessions/:id/services/:serviceId/refresh', async (c) => {
    const id = parseIdParam(c);
    const serviceId = c.req.param('serviceId');
    if (!serviceId) return c.json({ error: 'serviceId required' }, 400);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);
    const row = deps.companySandboxServicesStore.get(id, serviceId);
    if (!row || row.is_attached !== 1) {
      return c.json(
        { error: 'Refresh is only available for attached external containers.' },
        409,
      );
    }
    try {
      const sandbox = await getSandboxManager().refreshAttachedService(String(id), serviceId);
      return c.json({
        service_id: serviceId,
        container_id: sandbox.containerId,
        hostname: sandbox.attachedHostname ?? serviceId,
        status: sandbox.runtimePaused ? 'paused' : sandbox.status,
        runtime_paused: !!sandbox.runtimePaused,
        error: sandbox.error ?? null,
        last_checked_at: sandbox.lastAccessAt,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return c.json({ error: message }, 500);
    }
  });

  app.post('/api/company/sessions/:id/services/:serviceId/retry', async (c) => {
    const id = parseIdParam(c);
    const serviceId = c.req.param('serviceId');
    if (!serviceId) return c.json({ error: 'serviceId required' }, 400);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);
    const blocked = rejectIfAttached(id, serviceId);
    if (blocked) return c.json({ error: blocked.error }, blocked.status);

    // Retry re-provisions the service using the saved row — same
    // stack / limits / host workdir mount. Two recoverable states:
    //   1. Row exists (active, `error`, or soft-deleted `destroyed`
    //      from a transient teardown) → infer everything from it.
    //   2. Row is gone AND a project link with `label=serviceId`
    //      exists in `company_session_projects` → historical orphan
    //      (session 68 pattern). The UI sends `{ stack }` in the
    //      body so we can provision from scratch pointing at the
    //      pre-existing `root_path`. Files on disk are preserved;
    //      the scaffolder skips when `hasInitializedWorkdir` hits.
    const row = deps.companySandboxServicesStore.get(id, serviceId);
    interface RetryBody {
      stack?: string;
      name?: string;
      limits?: { memory?: string; cpus?: string; pids?: number };
    }
    const body = await parseJsonBody<RetryBody>(c).catch(() => null);

    let resolvedStack: string;
    let resolvedName: string;
    let limits: { memory?: string; cpus?: string; pids?: number } = {};
    let hostWorkdirMount: string | undefined;
    let forceRecreate: boolean;
    let provisionSpec:
      | ReturnType<typeof resolveExternalProjectSpec>
      | {};

    if (row) {
      resolvedStack = row.stack;
      resolvedName = row.name || row.service_id;
      try {
        limits = JSON.parse(row.limits_json) as typeof limits;
      } catch { /* ignore malformed limits */ }
      // Authoritative workdir: the UUID-based `root_path` of the
      // `projects` row the POST endpoint created for this service. Do
      // NOT trust `row.host_workdir_mount` — when an earlier provision
      // failed before reaching the post-create persist, that column
      // stays null and the manager falls back to the serviceId-based
      // legacy layout (`data/virtual-projects/<serviceId>`), which is
      // NOT the same path the scaffolder seeded / the agents have been
      // writing to.
      hostWorkdirMount = row.host_workdir_mount || undefined;
      try {
        const link = companyStore
          .listCompanySessionProjects(id)
          .find((p) => p.label === row.service_id);
        if (link) {
          const proj = db.getProject(link.project_id);
          if (proj?.root_path) hostWorkdirMount = proj.root_path;
        }
      } catch { /* fall back to row.host_workdir_mount */ }
      // Row present → manager still owns an in-memory Sandbox (even
      // a destroyed one from the same process); forceRecreate lets
      // the path tear it down and rebuild cleanly.
      forceRecreate = true;
      if (row.mount_kind === 'external') {
        try {
          if (row.image_source === 'project_dockerfile') {
            const dockerfilePath = row.dockerfile_path;
            const port = row.dockerfile_exposed_port;
            if (!dockerfilePath || !port) {
              throw new Error(
                'External Dockerfile service is missing Dockerfile metadata. Re-add it from the External project tab.',
              );
            }
            provisionSpec = {
              mountKind: 'external',
              imageSource: 'project_dockerfile',
              dockerfilePath,
              containerPortOverride: port,
              skipDefaultCommand: true,
            };
          } else if (hostWorkdirMount) {
            provisionSpec = resolveExternalProjectSpec(
              hostWorkdirMount,
              row.stack as BuilderStack,
              'node',
            );
          } else {
            throw new Error('External Node service is missing its project root.');
          }
        } catch (e) {
          return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      } else {
        provisionSpec = {};
      }
    } else {
      // Historical orphan: no row, but a project link may exist.
      const link = companyStore
        .listCompanySessionProjects(id)
        .find((p) => p.label === serviceId);
      if (!link) {
        return c.json({ error: `Service '${serviceId}' not found` }, 404);
      }
      const stack = body?.stack?.trim();
      if (!stack) {
        return c.json(
          {
            error:
              `Service '${serviceId}' has no saved stack (orphaned project). ` +
              `Pass { "stack": "<react-ts|vue-ts|vite-api|cf-worker|…>" } in the retry body.`,
          },
          400,
        );
      }
      resolvedStack = stack;
      const proj = db.getProject(link.project_id);
      resolvedName = body?.name ?? proj?.name ?? serviceId;
      if (body?.limits) limits = body.limits;
      hostWorkdirMount = proj?.root_path ?? undefined;
      forceRecreate = false;
      if (proj && !proj.name.startsWith('_builder_')) {
        try {
          provisionSpec = resolveExternalProjectSpec(proj.root_path, stack as BuilderStack);
        } catch (e) {
          return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      } else {
        provisionSpec = {};
      }
    }

    try {
      const sandbox = await getSandboxManager().provisionAdditionalService({
        sessionId: String(id),
        serviceId,
        stack: resolvedStack as BuilderStack,
        name: resolvedName,
        limits,
        hostWorkdirMount,
        forceRecreate,
        ...provisionSpec,
      });
      return c.json({
        service_id: serviceId,
        preview_url: sandbox.previewUrl,
        container_id: sandbox.containerId,
      });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  app.delete('/api/company/sessions/:id/services/:serviceId', async (c) => {
    const id = parseIdParam(c);
    const serviceId = c.req.param('serviceId');
    if (!serviceId) return c.json({ error: 'serviceId required' }, 400);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);
    await removeServiceAndProject(id, serviceId);
    return c.json({ ok: true });
  });

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
    //
    // We capture BOTH the ids AND the root_paths up-front.
    let virtualProjects: Array<{ id: number; rootPath: string }> = [];
    let cleanupMountKind: 'owned' | 'external' = 'owned';
    let builtImageTags: string[] = [];
    try {
      const primarySandboxRow = deps.companySandboxStore.get(id);
      if (primarySandboxRow?.mount_kind === 'external') cleanupMountKind = 'external';
      builtImageTags = [
        primarySandboxRow?.built_image_tag,
        ...deps.companySandboxServicesStore
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
    //
    // Both are idempotent and swallow errors individually — one
    // failure should not block cascading cleanup of the next artefact.
    try {
      const orch = orchestratorRegistry.get(id);
      if (orch) {
        orch.abortAll();
        orchestratorRegistry.delete(id);
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
