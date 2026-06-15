import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import { getCompanyOrchestrator } from '../../../sse/companyOrchestrator.js';
import { removeServiceAndProject } from './service-helpers.js';
import {
  validateAllowedModels,
  applyOperationalRulesPatch,
  type CreateSessionBody,
} from './session-create-validation.js';

export function mountCompanySessionRoutes(app: Hono, deps: ServerDeps): void {
  const { companyStore, db } = deps;

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

  /**
   * State snapshot — consolidated payload the dashboard fetches BEFORE
   * deciding whether to /attach. Resolves the "Iniciando Master..."
   * deadlock: when the orchestrator's master has already terminated,
   * /attach either 404s (orch evicted) or 200s with no event flow,
   * leaving the UI's `masterState` null forever.
   *
   * This endpoint always returns 200 when the session exists, with:
   *   - the usual `getCompanySessionFull` payload (session, projects,
   *     agentRuns, recentBoard, masterPrompts)
   *   - `liveOrchestrator`: orch still in the registry
   *   - `masterAlive`:      master has a live runner (not ended)
   *   - `masterEndedAt`:    ISO timestamp of master end, for the
   *                         "standby" badge
   *   - `pendingMasterInboxCount`: drives the "wake master" CTA
   */
  app.get('/api/company/sessions/:id/state-snapshot', async (c) => {
    const id = parseIdParam(c);
    try {
      companyStore.pruneOrphanCompanySessionProjects(id);
    } catch {
      /* same swallow as /sessions/:id */
    }
    const full = companyStore.getCompanySessionFull(id);
    if (!full) return notFound(c);

    const enrichedProjects = full.projects.map((p) => {
      const proj = db.getProject(p.project_id);
      return {
        ...p,
        project_name: proj?.name ?? `project-${p.project_id}`,
        root_path: proj?.root_path ?? '',
      };
    });

    const orchestrator = getCompanyOrchestrator(id);
    const liveOrchestrator = !!orchestrator;
    // Master liveness lives in the worker. Reading `orchestrator.isMasterAlive`
    // / `.masterEndedAt` directly off the worker-backed proxy returns a nested
    // proxy (not a value), which would blow up when `c.json` serializes it.
    // Fetch them through the awaited `getMasterStatus()` RPC instead. False /
    // null when the master never started, is mid-provision, or finished and is
    // sitting in standby — all safe to render WITHOUT the loader (the loader is
    // driven by `sandbox.provisioning` SSE frames, not these flags).
    let masterAlive = false;
    let masterEndedAt: string | null = null;
    if (orchestrator) {
      try {
        const status = await orchestrator.getMasterStatus();
        masterAlive = status.alive;
        masterEndedAt = status.endedAt;
      } catch (e) {
        // Worker may be mid-boot or evicting — degrade to "not alive" rather
        // than failing the whole snapshot.
        console.warn(
          `[company s=${id}] getMasterStatus failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    const pendingMasterInboxCount = companyStore.listInboxMessages({
      companySessionId: id,
      toRole: '__master__',
      status: 'pending',
      limit: 50,
    }).length;

    return c.json({
      ...full,
      projects: enrichedProjects,
      liveOrchestrator,
      masterAlive,
      masterEndedAt,
      pendingMasterInboxCount,
    });
  });

  /**
   * Wake the master — dashboard "Acordar Master" button. Pokes the
   * master inbox router so any pending messages get delivered with a
   * fresh resurrect attempt. Used when the operator sees the
   * "idle_pending" phase and wants to nudge progress without typing
   * a new message.
   *
   * Returns `{ revived, reason? }`:
   *   - `revived: true`   — pool was alive, tryDeliverNow fired.
   *   - `revived: false, reason: 'no_pending_inbox'` — nothing to
   *     deliver; the master just hasn't been re-pinged.
   *   - `revived: false, reason: 'orchestrator_idle'` — no live
   *     orchestrator for this session; the dashboard should fall
   *     through to /resume with a regular user message instead.
   */
  app.post('/api/company/sessions/:id/wake-master', async (c) => {
    const id = parseIdParam(c);
    if (!companyStore.getCompanySession(id)) return notFound(c);
    const orchestrator = getCompanyOrchestrator(id);
    if (!orchestrator) {
      return c.json({ revived: false, reason: 'orchestrator_idle' });
    }
    const pending = companyStore.listInboxMessages({
      companySessionId: id,
      toRole: '__master__',
      status: 'pending',
      limit: 1,
    });
    if (pending.length === 0) {
      return c.json({ revived: false, reason: 'no_pending_inbox' });
    }
    // Forward to the in-process inbox router. The router is idempotent
    // + uses an atomic claim, so spamming this endpoint is safe.
    await orchestrator.tryDeliverMasterInboxNow();
    return c.json({ revived: true });
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
    // A project link is mandatory — the orchestrator wouldn't know which
    // workspace to operate on without one.
    if (!body.name || !body.project_ids?.length) {
      return c.json({ error: 'name and project_ids required' }, 400);
    }

    for (const pid of body.project_ids) {
      const proj = db.getProject(pid);
      if (!proj) return c.json({ error: `Project ${pid} not found` }, 404);
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
        // Session-level operational rules — injected verbatim into the master
        // and every subordinate prompt at start/spawn/resume. Absent when blank.
        ...(body.operational_rules?.trim()
          ? { operational_rules: body.operational_rules.trim() }
          : {}),
      }),
    });

    for (const pid of body.project_ids) {
      companyStore.addProjectToCompanySession(
        session.id,
        pid,
        body.project_labels?.[pid],
      );
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
      /** Session-level operational rules (markdown). Empty string clears them. */
      operational_rules?: string;
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

    const orch = getCompanyOrchestrator(id);
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

    // Operational rules round-trip to the DB whether or not the session is
    // running — spawn/resume read them fresh from config_json (see helper).
    if (body.operational_rules !== undefined) {
      applyOperationalRulesPatch(companyStore, id, body.operational_rules);
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
