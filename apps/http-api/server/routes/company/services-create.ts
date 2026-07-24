/**
 * Creation paths for company microservices:
 *   - `POST /api/company/sessions/:id/services` — provision a brand-new
 *     owned-image container (scaffolder seeds a `_builder_*` project +
 *     workdir), optionally bind-mounted onto an existing external project.
 *   - `POST /api/company/sessions/:id/services/attach` — adopt a
 *     pre-existing host container by its docker/podman ID or name.
 *
 * Extracted from `services.ts` to keep the file under the LOC cap.
 */
import type { Hono } from 'hono';
import { mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { virtualProjectDir } from '@mcp/shared/utils/data-paths.js';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import { getSandboxManager } from '@mcp/services/sandbox/index.js';
import type { BuilderStack } from '@mcp/services/sandbox/types.js';
import { isMutationOutcomeUnknownError } from '@mcp/orchestrator-host';
import {
  evictCompanyOrchestrator,
  getCompanyOrchestrator,
} from '../../../sse/companyOrchestrator.js';
import {
  isExternalProjectRuntime,
  resolveExternalProjectSpec,
  type ExternalProjectRuntime,
} from './sandbox-helpers.js';

export function mountCompanyServicesCreateRoutes(app: Hono, deps: ServerDeps): void {
  const { companyStore, db } = deps;

  // ─── Add a new owned-image microservice ─────────────────────────

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
        rootPath = virtualProjectDir(uuid);
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

    const orch = getCompanyOrchestrator(id);
    try {
      if (orch) {
        const binding = await orch.addSandboxService({
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
      if (orch && isMutationOutcomeUnknownError(e)) {
        // Provisioning may have created the container before the worker's ACK
        // was lost. Rolling back the linked project/workdir here would corrupt
        // that possibly-live service, so preserve all durable inputs, fence the
        // stale worker, and require explicit reconciliation by the operator.
        await evictCompanyOrchestrator(id);
        return c.json({
          error:
            'Service provisioning outcome is unknown because its worker ' +
            'acknowledgement was lost; no destructive rollback was performed.',
          code: 'OUTCOME_UNKNOWN',
          service_id: body.service_id,
          project_id: projectId,
          root_path: rootPath,
        }, 500);
      }
      // Rollback: unlink FIRST (no FK cascade toward projects means a
      // bare deleteProject would leave an orphan row that the UI
      // renders as `project-<id>` in the sidebar forever), then drop
      // the project row and wipe the empty workdir we just mkdirSync'd.
      try { companyStore.removeProjectFromCompanySession(id, projectId); } catch { /* best effort */ }
      if (createdOwnedProject) {
        try {
          await deps.projectIndexService.stopWatching(projectId).catch(() => undefined);
          await deps.semanticCoordinator.removeProject(projectId, {
            finalize: () => db.deleteProject(projectId),
          });
          await rm(rootPath, { recursive: true, force: true });
        } catch (cleanupError) {
          console.warn(
            `[company] rollback project ${projectId} kept after cleanup failure: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          );
        }
      }
      const message = e instanceof Error ? e.message : String(e);
      return c.json({ error: message }, 400);
    }
  });

  // ─── Attach to an existing external container ───────────────────

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
}
