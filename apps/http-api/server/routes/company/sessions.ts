import type { Hono } from 'hono';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import type { BuilderStack } from '@mcp/services/sandbox/types.js';
import { StackSnapshotSeeder } from '@mcp/company/services/stack-snapshot-seeder.js';
import { orchestratorRegistry } from '../../../sse/OrchestratorRegistry.js';
import {
  isBuilderStack,
  isExternalProjectRuntime,
  validateLimits,
} from './sandbox-helpers.js';
import { removeServiceAndProject } from './service-helpers.js';
import {
  validateAllowedModels,
  type CreateSessionBody,
} from './session-create-validation.js';

export function mountCompanySessionRoutes(app: Hono, deps: ServerDeps): void {
  const { companyStore, db, snapshotService } = deps;
  const stackSnapshotSeeder = new StackSnapshotSeeder(snapshotService);

  // Phase 8 part 2 (continuation): the following helpers + routes moved out:
  //   - `removeServiceAndProject`            → `service-helpers.ts` (used by
  //                                            both `services.ts` DELETE
  //                                            /services/:sid AND the
  //                                            DELETE /projects/:pid below)
  //   - `startPrimarySandboxForSession`      → `service-helpers.ts`
  //   - `serviceStartPayload`                → `service-helpers.ts`
  //   - `rejectIfAttached` (local wrapper)   → `services.ts` (only caller)
  //   - POST  /:id/sandbox, /sandbox/restart-dev, GET /sandbox/logs, GET /sandbox
  //                                          → `sandbox.ts`
  //   - GET   /:id/services                  → `services.ts`
  //   - POST  /:id/services                  → `services.ts`
  //   - POST  /:id/services/attach           → `services.ts`
  //   - POST  /:id/services/:sid/start       → `services.ts`
  //   - POST  /:id/services/:sid/refresh     → `services.ts`
  //   - POST  /:id/services/:sid/retry       → `services.ts`
  //   - DELETE /:id/services/:sid            → `services.ts`
  //   - GET   /:id/delete-plan + DELETE /:id → `session-delete.ts`
  //   - pause/unpause/logs/restart-dev (svc) → `service-lifecycle.ts`

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
        // Phase B "master observer": when true, every peer-to-peer
        // inbox message also enqueues a fire-and-forget `notify` copy
        // for the master so it stays aware of inter-subordinate
        // traffic. Default off (absent) — opt-in via the dialog.
        ...(body.master_broadcast_subscribe === true
          ? { master_broadcast_subscribe: true }
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
        await removeServiceAndProject(deps, sessionId, link.label);
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

  // Phase 8 part 2 (continuation): sandbox routes moved to `sandbox.ts`.
  //   - POST  /:id/sandbox                  → `sandbox.ts`
  //   - POST  /:id/sandbox/restart-dev      → `sandbox.ts`
  //   - GET   /:id/sandbox/logs             → `sandbox.ts`
  //   - GET   /:id/sandbox                  → `sandbox.ts`
  //   - POST  /:id/services/:sid/start      → `services.ts`

  // Phase 8: route groups moved out of this file:
  //   - `GET/PUT/DELETE /envs/*`          → `envs.ts`
  //   - `GET /docs/list`, `/docs/read`    → `docs.ts`
  //   - `GET /services/:sid/openapi`      → `openapi.ts`

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

  // Rename a session (parent or child). Children also accept rename via
  // /sessions/:parentId/children/:childId; this top-level route is used
  // by the front tabs bar to rename the "Main" tab (the parent itself).
  app.patch('/api/company/sessions/:id', async (c) => {
    const id = parseIdParam(c);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);
    interface RenameBody { name?: string }
    const body = await parseJsonBody<RenameBody>(c);
    const name = (body?.name ?? '').trim();
    if (!name) return c.json({ error: 'name is required' }, 400);
    companyStore.renameCompanySession(id, name);
    return c.json({ session: companyStore.getCompanySession(id) });
  });

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

  // Phase 8 part 2 (continuation): the multi-service CRUD surface
  // (GET/POST/DELETE /:id/services*, attach/refresh/retry) moved to
  // `services.ts`. Helpers shared with DELETE /projects/:projectId above
  // (`removeServiceAndProject`) live in `service-helpers.ts`.

  // `GET /delete-plan` + `DELETE /:id` moved to `session-delete.ts` in
  // Phase 8 part 2.
}
