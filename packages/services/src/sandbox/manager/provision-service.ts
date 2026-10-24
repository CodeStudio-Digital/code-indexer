/**
 * Provision a SECONDARY service container for a session. The big sibling
 * of `provision` (primary sandbox) — same lifecycle pattern (seed → build
 * image if needed → create container → workdir prep → scaffolder/dev-server
 * → ready), but with three extra concerns:
 *
 *   1. **Shared docker network** — siblings address each other by
 *      service_id hostname, so the network must exist and the primary
 *      (if any) must be attached too.
 *   2. **Per-service preview URL** — uses the
 *      `/preview/:sessionId/_svc/:serviceId/` shape (not the primary's
 *      `/preview/:sessionId/`) to avoid HMAC cookie confusion when a
 *      slash leaks into the sessionId.
 *   3. **Mount-kind branching** — owned vs external vs Dockerfile.
 *      External mounts skip scaffolder + .env injection (user owns
 *      those); Dockerfile builds run their own image build before create.
 *
 * Extracted from `SandboxManager.provisionAdditionalService` so the
 * lifecycle is documented in one place and the deps surface is explicit.
 * The deps bag is intentionally wide — every collaborator the original
 * method touched is listed here.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Sandbox,
  SandboxEvent,
  SandboxLogLine,
  SandboxStep,
} from '@mcp/services/sandbox/types.js';
import {
  DEFAULT_SANDBOX_ISOLATION,
  DEFAULT_SANDBOX_LIMITS,
} from '@mcp/services/sandbox/types.js';
import type { ProvisionServiceRequest } from '../sandbox-manager/types.js';
import type { ISandboxDriver } from '@mcp/services/sandbox/ports/sandbox-driver.js';
import type { PortAllocator } from '@mcp/services/sandbox/port-allocator.js';
import type { SandboxRegistry } from '@mcp/services/sandbox/manager/state/registry.js';
import type { PersistedSandboxStatus } from '@mcp/store/company-sandbox-store.js';
import { getScaffolder } from '@mcp/services/sandbox/scaffolders/registry.js';
import { previewPathPrefixOf } from '@mcp/services/sandbox/manager/util/preview-url.js';
import {
  nodeModulesVolumeFor,
  projectImageTag,
} from '@mcp/services/sandbox/manager/util/naming.js';
import { hasInitializedWorkdir } from '@mcp/services/sandbox/manager/util/paths.js';
import {
  importDotEnvIntoStore,
  renderDotEnv,
  resolveHostWorkdirMount,
  resolveSessionEnvs,
} from '@mcp/services/sandbox/manager/io/env-helpers.js';
import {
  captureContainerDiagnostic,
  relaunchDevServer,
  waitForPublishedHttp,
} from '@mcp/services/sandbox/manager/dev-server-runtime.js';
import {
  resolveExternalNodeDevSpec,
  startExternalNodeDevServer,
  type ExternalNodeRuntimeDeps,
} from '@mcp/services/sandbox/manager/external-node-runtime.js';
import {
  reconcilePrimaryForSession,
  reconcileServiceForSession,
  type ReconcileDeps,
} from '@mcp/services/sandbox/manager/reconcile.js';
import { prepareWorkdir } from '@mcp/services/sandbox/manager/prepare-workdir.js';
import type { CompanySessionEnvStore } from '@mcp/store/company-session-env-store.js';
import type { CompanySandboxServicesStore } from '@mcp/store/company-sandbox-services-store.js';

export interface ProvisionServiceDeps {
  /** Resolved driver — caller awaits `resolveDriverOnce()` before invoking. */
  driver: ISandboxDriver;
  registry: SandboxRegistry;
  allocator: PortAllocator;
  envStore: CompanySessionEnvStore | null;
  servicesStore: CompanySandboxServicesStore | null;

  /** Concurrency cap shared with the primary sandboxes. */
  maxSandboxes: number;
  /** Default workdir inside the container (usually `/app`). */
  workdir: string;
  /** Default Node image (used when not a project_dockerfile build). */
  nodeImage: string;
  /** Default container dev-server port. */
  devServerPort: number;

  emit: (event: SandboxEvent) => void;
  recordStep: (sb: Sandbox, step: SandboxStep, message: string) => void;
  appendLog: (sb: Sandbox, level: SandboxLogLine['level'], text: string) => void;

  persistService: (
    sessionId: string,
    serviceId: string,
    name: string,
    sb: Sandbox,
    status: PersistedSandboxStatus,
  ) => void;
  syncManagedEnvs: (sessionId: string) => Promise<void>;
  syncEnvsToAllContainers: (sessionId: string) => Promise<void>;
  destroyService: (sessionId: string, serviceId: string, reason: string) => Promise<void>;

  reconcileDeps: ReconcileDeps;
  externalNodeRuntimeDeps: ExternalNodeRuntimeDeps;

  ensureSessionNetwork: (sessionId: string) => Promise<string | null>;
  attachContainerToSessionNetwork: (
    sessionId: string,
    containerId: string,
    alias: string,
  ) => Promise<void>;
}

export async function provisionAdditionalService(
  req: ProvisionServiceRequest,
  deps: ProvisionServiceDeps,
): Promise<Sandbox> {
  if (req.serviceId === 'main') {
    throw new Error(`service_id 'main' is reserved for the primary sandbox`);
  }
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(req.serviceId)) {
    throw new Error(
      `Invalid service_id '${req.serviceId}' — use lowercase letters, digits, hyphen; ≤32 chars`,
    );
  }

  await reconcilePrimaryForSession(deps.driver, req.sessionId, deps.reconcileDeps).catch(
    (e: unknown) =>
      console.warn(
        `[sandbox-manager] targeted primary reconcile ${req.sessionId} failed: ${e instanceof Error ? e.message : String(e)}`,
      ),
  );
  await reconcileServiceForSession(
    deps.driver,
    req.sessionId,
    req.serviceId,
    deps.reconcileDeps,
  ).catch((e: unknown) =>
    console.warn(
      `[sandbox-manager] targeted service reconcile ${req.sessionId}:${req.serviceId} failed: ${e instanceof Error ? e.message : String(e)}`,
    ),
  );

  const primary = deps.registry.getPrimary(req.sessionId);

  const existing = deps.registry.getService(req.sessionId, req.serviceId);
  if (existing) {
    if (!req.forceRecreate) return existing;
    try {
      await deps.destroyService(req.sessionId, req.serviceId, 'retry');
    } catch (e) {
      console.warn(
        `[sandbox-manager] forceRecreate destroy ${req.sessionId}:${req.serviceId} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  const inUseCount = deps.registry.primary.size + deps.registry.services.size;
  if (inUseCount >= deps.maxSandboxes) {
    throw new Error(`Too many concurrent sandboxes (${inUseCount}/${deps.maxSandboxes}).`);
  }

  const networkName = await deps.ensureSessionNetwork(req.sessionId);
  if (networkName && primary?.containerId) {
    await deps.attachContainerToSessionNetwork(req.sessionId, primary.containerId, 'main');
  }

  const hostPort = await deps.allocator.acquire();
  // Phase C: direct loopback URL — the /preview/:id/_svc/:serviceId/ proxy
  // was removed. Vite/Next/etc. inside the container serve at root, so
  // `base: '/'` works without prefix injection.
  const previewUrl = `http://127.0.0.1:${hostPort}/`;
  const seedLimits = { ...DEFAULT_SANDBOX_LIMITS, ...(req.limits ?? {}) };
  const serviceSandboxId = `${req.sessionId}:${req.serviceId}`;
  const mountKind = req.mountKind ?? 'owned';
  const imageSource = req.imageSource ?? 'default';
  let containerPort = req.containerPortOverride ?? deps.devServerPort;
  const builtImageTag =
    imageSource === 'project_dockerfile'
      ? projectImageTag(req.sessionId, req.serviceId)
      : undefined;

  const seed: Sandbox = {
    id: serviceSandboxId,
    containerId: '',
    runtime: deps.driver.runtime,
    stack: req.stack,
    hostPort,
    workdir: deps.workdir,
    containerPort,
    previewUrl,
    limits: seedLimits,
    status: 'pending',
    runtimePaused: false,
    step: 'queued',
    recentLogs: [],
    createdAt: Date.now(),
    lastAccessAt: Date.now(),
    hostWorkdirMount: req.hostWorkdirMount,
    mountKind,
    imageSource,
    builtImageTag,
    dockerfilePath: req.dockerfilePath,
    dockerfileExposedPort: imageSource === 'project_dockerfile' ? containerPort : undefined,
  };
  deps.registry.setService(req.sessionId, req.serviceId, seed);
  deps.persistService(req.sessionId, req.serviceId, req.name ?? req.serviceId, seed, 'provisioning');
  deps.emit({ kind: 'provisioning', sandboxId: serviceSandboxId, stack: req.stack });

  try {
    seed.status = 'provisioning';

    const isolation = {
      ...DEFAULT_SANDBOX_ISOLATION,
      network: networkName ?? DEFAULT_SANDBOX_ISOLATION.network,
    };
    const limits = { ...DEFAULT_SANDBOX_LIMITS, ...(req.limits ?? {}) };

    const perServiceHostRoot = resolveHostWorkdirMount(req.sessionId);
    const hostWorkdirMount =
      req.hostWorkdirMount ??
      (perServiceHostRoot ? join(perServiceHostRoot, req.serviceId) : null);

    let externalNodeSpec:
      | ReturnType<typeof resolveExternalNodeDevSpec>
      | null = null;
    if (mountKind === 'external') {
      if (!hostWorkdirMount) {
        throw new Error('External projects require a registered project root to bind-mount.');
      }
      if (imageSource === 'project_dockerfile') {
        if (!req.dockerfilePath || !req.containerPortOverride) {
          throw new Error("Dockerfile doesn't EXPOSE a port — add `EXPOSE <n>` or choose Node dev image.");
        }
      } else {
        externalNodeSpec = resolveExternalNodeDevSpec(
          hostWorkdirMount,
          req.stack,
          req.containerPortOverride,
          deps.devServerPort,
        );
        containerPort = externalNodeSpec.containerPort;
        seed.containerPort = containerPort;
        seed.dockerfileExposedPort = containerPort;
      }
    }
    const nodeModulesVolumeName =
      hostWorkdirMount && mountKind !== 'external'
        ? `${nodeModulesVolumeFor(req.sessionId)}-${req.serviceId}`
        : undefined;
    if (hostWorkdirMount) {
      try {
        if (mountKind === 'external') {
          if (!existsSync(hostWorkdirMount)) {
            throw new Error(`Project root does not exist: ${hostWorkdirMount}`);
          }
        } else {
          mkdirSync(hostWorkdirMount, { recursive: true });
        }
      } catch (e) {
        throw new Error(
          `Failed to prepare host workdir ${hostWorkdirMount}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      if (mountKind !== 'external') {
        await importDotEnvIntoStore(deps.envStore, hostWorkdirMount, req.sessionId);
      }
    }

    // Scope-enforced (D1): vars bound to other services stay out of this one.
    const sharedEnvs = resolveSessionEnvs(deps.envStore, req.sessionId, req.serviceId);
    const image = imageSource === 'project_dockerfile' ? builtImageTag! : deps.nodeImage;
    if (imageSource === 'project_dockerfile') {
      deps.recordStep(seed, 'creating-container', 'Building image from Dockerfile…');
      await deps.driver.build({
        contextDir: hostWorkdirMount!,
        dockerfilePath: req.dockerfilePath!,
        imageTag: image,
        signal: req.signal,
        noCache: req.forceRecreate === true,
        emit: (event) => {
          deps.appendLog(seed, event.stream === 'stderr' ? 'error' : 'info', event.chunk);
          deps.emit({
            kind: 'log',
            sandboxId: serviceSandboxId,
            stream: event.stream,
            chunk: event.chunk,
          });
        },
      });
    }
    const { containerId } = await deps.driver.create({
      sandboxId: serviceSandboxId,
      image,
      stack: req.stack,
      workdir: deps.workdir,
      hostPort,
      containerPort,
      limits,
      isolation,
      env: Object.keys(sharedEnvs).length > 0 ? sharedEnvs : undefined,
      hostWorkdirMount: hostWorkdirMount ?? undefined,
      nodeModulesVolumeName,
      skipDefaultCommand: req.skipDefaultCommand ?? imageSource === 'project_dockerfile',
    });
    seed.containerId = containerId;
    seed.hostWorkdirMount = hostWorkdirMount ?? undefined;
    seed.nodeModulesVolumeName = nodeModulesVolumeName;

    if (mountKind !== 'external') {
      await prepareWorkdir(deps.driver, containerId, deps.workdir, isolation.user);
    }
    if (mountKind !== 'external' && Object.keys(sharedEnvs).length > 0) {
      try {
        await deps.driver.writeFile(
          containerId,
          `${deps.workdir}/.env`,
          renderDotEnv(sharedEnvs),
          { recursive: true },
        );
      } catch (e) {
        deps.appendLog(
          seed,
          'info',
          `(non-fatal) write .env failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    const hostWorkdirPopulated =
      !!hostWorkdirMount && hasInitializedWorkdir(hostWorkdirMount);

    if (imageSource === 'project_dockerfile') {
      deps.recordStep(seed, 'starting-dev-server', 'Waiting for project container…');
      await waitForPublishedHttp(deps.driver, seed, '/', { signal: req.signal });
    } else if (mountKind === 'external' && externalNodeSpec) {
      await startExternalNodeDevServer(
        deps.driver,
        seed,
        externalNodeSpec,
        deps.externalNodeRuntimeDeps,
        req.signal,
      );
    } else if (hostWorkdirPopulated) {
      deps.recordStep(seed, 'starting-dev-server', 'Resuming persisted workdir…');
      await relaunchDevServer(deps.driver, containerId, deps.workdir, req.stack, deps.devServerPort, req.signal);
    } else {
      const scaffolder = getScaffolder(req.stack);
      await scaffolder.scaffold({
        sandboxId: serviceSandboxId,
        containerId,
        workdir: deps.workdir,
        devServerPort: deps.devServerPort,
        previewUrl,
        previewPathPrefix: previewPathPrefixOf(previewUrl),
        driver: deps.driver,
        signal: req.signal,
        emit: (e) => {
          if (e.kind === 'step') deps.recordStep(seed, e.step, e.message);
          else if (e.kind === 'log') deps.appendLog(seed, 'info', e.chunk);
          deps.emit(e);
        },
      });
    }

    seed.status = 'ready';
    seed.runtimePaused = false;
    seed.step = 'ready';
    seed.lastAccessAt = Date.now();
    deps.persistService(req.sessionId, req.serviceId, req.name ?? req.serviceId, seed, 'running');
    deps.emit({ kind: 'ready', sandboxId: serviceSandboxId, previewUrl });
    // Session-keyed sibling of `ready` (company B2) — see SandboxEvent union.
    deps.emit({ kind: 'service_provisioned', sandboxId: req.sessionId, serviceId: req.serviceId });
    await deps.syncManagedEnvs(req.sessionId);
    void deps.syncEnvsToAllContainers(req.sessionId).catch(() => void 0);
    return seed;
  } catch (e) {
    const baseMessage = e instanceof Error ? e.message : String(e);
    const diagnostic = seed.containerId
      ? await captureContainerDiagnostic(deps.driver, seed.containerId)
      : '';
    const message = diagnostic ? `${baseMessage}\n\n${diagnostic}` : baseMessage;
    seed.status = 'error';
    seed.step = 'error';
    seed.error = message;
    if (diagnostic) deps.appendLog(seed, 'error', diagnostic);
    deps.persistService(req.sessionId, req.serviceId, req.name ?? req.serviceId, seed, 'error');
    deps.emit({ kind: 'error', sandboxId: serviceSandboxId, message });
    if (seed.containerId) {
      try { await deps.driver.destroy(seed.containerId); } catch { /* logged */ }
    }
    throw new Error(message);
  }
}
