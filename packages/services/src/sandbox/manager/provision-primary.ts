/**
 * Provision (or re-provision) the PRIMARY sandbox for a session. The
 * sibling of `provisionAdditionalService` for secondary services.
 *
 * Lifecycle:
 *   1. Reconcile in-memory state with the DB BEFORE the early-return
 *      branch — a row may have just been reclaimed by the boot sweep.
 *   2. If `existing` is found, branch by status:
 *      - retry + (error/running/destroyed) → tear down + fall through
 *      - paused → resumeSandbox (cheap ~5s)
 *      - pending/provisioning/destroying → return as-is (in-flight race)
 *      - ready/error → inspect container; heal silently when the
 *        in-memory entry points at a dead container.
 *   3. Concurrency cap enforced before allocating a port.
 *   4. Seed pending row + persist EARLY so a mid-create crash leaves a
 *      breadcrumb the next boot can clean up.
 *   5. Build Dockerfile image (project_dockerfile path) → create
 *      container → prepareWorkdir + .env materialization.
 *   6. Persistence decision tree (4 paths): bind-mount populated /
 *      legacy archive / external Node / fresh scaffold.
 *   7. Mark ready + persist 'running' + syncManagedEnvs + emit `ready`.
 *
 * Error path: keep the in-memory record in 'error' state (so the UI
 * shows context for retry) but destroy the half-built container in
 * docker/podman. Port stays claimed — intentional.
 *
 * Extracted from `SandboxManager.provision` so the decision tree is
 * documented in one place. The deps bag is wide; every collaborator
 * the original method touched is listed in `ProvisionPrimaryDeps`.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
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
import type { ISandboxDriver } from '@mcp/services/sandbox/ports/sandbox-driver.js';
import type { PortAllocator } from '@mcp/services/sandbox/port-allocator.js';
import type { SandboxRegistry } from '@mcp/services/sandbox/manager/state/registry.js';
import type { PersistedSandboxStatus } from '@mcp/store/company-sandbox-store.js';
import type { CompanySessionEnvStore } from '@mcp/store/company-session-env-store.js';
import { getNetworkController } from '@mcp/services/sandbox/network-controller.js';
import { getScaffolder } from '@mcp/services/sandbox/scaffolders/registry.js';
import { archivePath, loadArchive } from '@mcp/services/sandbox/archive.js';
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
  reconcileServicesForSession,
  type ReconcileDeps,
} from '@mcp/services/sandbox/manager/reconcile.js';
import { prepareWorkdir } from '@mcp/services/sandbox/manager/prepare-workdir.js';
import type { ProvisionRequest } from '@mcp/services/sandbox/sandbox-manager.js';

export interface ProvisionPrimaryDeps {
  driver: ISandboxDriver;
  registry: SandboxRegistry;
  allocator: PortAllocator;
  envStore: CompanySessionEnvStore | null;

  maxSandboxes: number;
  workdir: string;
  nodeImage: string;
  devServerPort: number;
  buildPreviewUrl: (sessionId: string, hostPort: number) => string;

  emit: (event: SandboxEvent) => void;
  recordStep: (sb: Sandbox, step: SandboxStep, message: string) => void;
  appendLog: (sb: Sandbox, level: SandboxLogLine['level'], text: string) => void;

  persist: (sb: Sandbox, statusOverride?: PersistedSandboxStatus) => void;
  syncManagedEnvs: (sessionId: string) => void;

  destroyInternal: (sessionId: string, reason: string) => Promise<void>;
  resumeSandbox: (sessionId: string) => Promise<Sandbox>;
  listServices: (sessionId: string) => Sandbox[];

  reconcileDeps: ReconcileDeps;
  externalNodeRuntimeDeps: ExternalNodeRuntimeDeps;

  ensureSessionNetwork: (sessionId: string) => Promise<string | null>;
  attachContainerToSessionNetwork: (
    sessionId: string,
    containerId: string,
    alias: string,
  ) => Promise<void>;
}

export async function provisionPrimarySandbox(
  req: ProvisionRequest,
  deps: ProvisionPrimaryDeps,
): Promise<Sandbox> {
  await reconcilePrimaryForSession(deps.driver, req.sessionId, deps.reconcileDeps).catch(
    (e: unknown) =>
      console.warn(
        `[sandbox-manager] targeted primary reconcile ${req.sessionId} failed: ${e instanceof Error ? e.message : String(e)}`,
      ),
  );
  await reconcileServicesForSession(deps.driver, req.sessionId, deps.reconcileDeps).catch(
    (e: unknown) =>
      console.warn(
        `[sandbox-manager] targeted services reconcile ${req.sessionId} failed: ${e instanceof Error ? e.message : String(e)}`,
      ),
  );

  const existing = deps.registry.getPrimary(req.sessionId);
  if (existing) {
    // `retry:true` from the UI's "Retry primary" button means "tear
    // this down and rebuild, whatever state you're in" — the user
    // already clicked because the current container is broken in a way
    // we can't detect. Honor retry on 'error' AND on healthy-looking
    // 'running' too. In-flight 'provisioning' / 'pending' windows are
    // left alone — the running provision is already recreating; double-
    // teardown would race.
    const retryable = new Set(['error', 'running', 'destroyed']);
    if (req.retry && retryable.has(existing.status)) {
      await deps.destroyInternal(req.sessionId, 'retry-after-error');
    } else if (existing.status === 'paused') {
      return await deps.resumeSandbox(req.sessionId);
    } else if (
      existing.status === 'pending' ||
      existing.status === 'provisioning' ||
      existing.status === 'destroying'
    ) {
      existing.lastAccessAt = Date.now();
      deps.persist(existing);
      return existing;
    } else {
      // 'ready' / 'error' fall here. Verify the container actually
      // exists in the runtime before trusting the in-memory entry —
      // a stale binding pointing at a dead `containerId` would make
      // every subsequent tool call fail with `container "" does not
      // exist`. Heal transparently by falling through to a fresh
      // provision when the runtime disagrees.
      let alive = true;
      if (existing.containerId) {
        try {
          const inspect = await deps.driver.inspectContainer(existing.containerId);
          alive = inspect.exists && (inspect.running || inspect.paused);
          existing.runtimePaused = inspect.paused;
        } catch {
          alive = false;
        }
      } else {
        alive = false;
      }
      if (alive) {
        existing.lastAccessAt = Date.now();
        deps.persist(existing);
        return existing;
      }
      console.warn(
        `[sandbox-manager] in-memory sandbox ${req.sessionId} points at a dead container ${(existing.containerId || '<empty>').slice(0, 12)} — auto-reprovisioning (host bind-mount preserves files)`,
      );
      await deps.destroyInternal(req.sessionId, 'container-disappeared').catch(() => void 0);
    }
  }
  if (deps.registry.primary.size >= deps.maxSandboxes) {
    throw new Error(
      `Too many concurrent sandboxes (${deps.registry.primary.size}/${deps.maxSandboxes}). ` +
        `Close an existing builder session or raise MCP_MAX_SANDBOXES.`,
    );
  }

  const hostPort = await deps.allocator.acquire();
  const previewUrl = deps.buildPreviewUrl(req.sessionId, hostPort);
  const mountKind = req.mountKind ?? 'owned';
  const imageSource = req.imageSource ?? 'default';
  let containerPort = req.containerPortOverride ?? deps.devServerPort;
  const builtImageTag =
    imageSource === 'project_dockerfile' ? projectImageTag(req.sessionId, 'main') : undefined;

  const seedLimits = { ...DEFAULT_SANDBOX_LIMITS, ...(req.limits ?? {}) };
  const seed: Sandbox = {
    id: req.sessionId,
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
  deps.registry.primary.set(req.sessionId, seed);
  deps.persist(seed, 'provisioning');
  deps.emit({ kind: 'provisioning', sandboxId: req.sessionId, stack: req.stack });
  deps.recordStep(seed, 'creating-container', 'Starting container…');

  try {
    seed.status = 'provisioning';
    const egress = await getNetworkController().ensure();
    const isolation = egress
      ? {
          ...DEFAULT_SANDBOX_ISOLATION,
          network: DEFAULT_SANDBOX_ISOLATION.network ?? egress.networkName,
          httpProxy: DEFAULT_SANDBOX_ISOLATION.httpProxy ?? egress.proxyUrl,
        }
      : DEFAULT_SANDBOX_ISOLATION;

    const limits = { ...DEFAULT_SANDBOX_LIMITS, ...(req.limits ?? {}) };
    const hostWorkdirMount = req.hostWorkdirMount ?? resolveHostWorkdirMount(req.sessionId);

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
        ? nodeModulesVolumeFor(req.sessionId)
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
        importDotEnvIntoStore(deps.envStore, hostWorkdirMount, req.sessionId);
      }
    }

    // 'main' = the primary container's service id for scope enforcement (D1).
    const sharedEnvs = resolveSessionEnvs(deps.envStore, req.sessionId, 'main');
    // Project Dockerfiles always run their freshly-built tag; otherwise honor a
    // per-session `image` override, falling back to the manager's node image.
    const image =
      imageSource === 'project_dockerfile' ? builtImageTag! : req.image ?? deps.nodeImage;
    if (imageSource === 'project_dockerfile') {
      deps.recordStep(seed, 'creating-container', 'Building image from Dockerfile…');
      await deps.driver.build({
        contextDir: hostWorkdirMount!,
        dockerfilePath: req.dockerfilePath!,
        imageTag: image,
        signal: req.signal,
        noCache: req.retry === true,
        emit: (event) => {
          deps.appendLog(seed, event.stream === 'stderr' ? 'error' : 'info', event.chunk);
          deps.emit({
            kind: 'log',
            sandboxId: req.sessionId,
            stream: event.stream,
            chunk: event.chunk,
          });
        },
      });
    }
    const { containerId } = await deps.driver.create({
      sandboxId: req.sessionId,
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
      runArgs: req.runArgs,
    });
    seed.containerId = containerId;
    seed.hostWorkdirMount = hostWorkdirMount ?? undefined;
    seed.nodeModulesVolumeName = nodeModulesVolumeName;

    // If secondary services were started before main, connect the
    // primary container to their shared network now. When main starts
    // first, provisionAdditionalService handles this on the first
    // service start, so avoid creating an unused network here.
    if (deps.listServices(req.sessionId).length > 0) {
      const networkName = await deps.ensureSessionNetwork(req.sessionId);
      if (networkName) {
        await deps.attachContainerToSessionNetwork(req.sessionId, containerId, 'main');
      }
    }

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

    // Persistence decision tree (4 paths): bind-mount populated /
    // legacy archive / external Node / fresh scaffold.
    const hostWorkdirPopulated =
      !!hostWorkdirMount && hasInitializedWorkdir(hostWorkdirMount);

    let archiveToRestore = req.restoreArchive;
    if (!archiveToRestore && !hostWorkdirPopulated) {
      try {
        const auto = await loadArchive(req.sessionId);
        if (auto) {
          archiveToRestore = auto;
          deps.appendLog(seed, 'info', 'Restoring workdir from previous session archive…');
        }
      } catch (e) {
        deps.appendLog(
          seed,
          'info',
          `(non-fatal) could not read archive: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

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
    } else if (archiveToRestore) {
      deps.recordStep(seed, 'installing-deps', 'Restoring workdir from archive…');
      await deps.driver.importWorkdir(containerId, deps.workdir, archiveToRestore);
      if (hostWorkdirMount) {
        try {
          rmSync(archivePath(req.sessionId), { force: true });
        } catch {
          /* best effort */
        }
      }
      deps.recordStep(seed, 'starting-dev-server', 'Starting dev server…');
      await relaunchDevServer(deps.driver, containerId, deps.workdir, req.stack, deps.devServerPort, req.signal);
    } else {
      const scaffolder = getScaffolder(req.stack, {
        includeE2e: req.includeE2e,
      });
      await scaffolder.scaffold({
        sandboxId: req.sessionId,
        containerId,
        workdir: deps.workdir,
        devServerPort: deps.devServerPort,
        previewUrl,
        previewPathPrefix: previewPathPrefixOf(previewUrl),
        driver: deps.driver,
        signal: req.signal,
        includeE2e: req.includeE2e,
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
    deps.appendLog(seed, 'info', 'Dev server is ready.');
    deps.persist(seed, 'running');
    deps.syncManagedEnvs(req.sessionId);
    deps.emit({ kind: 'ready', sandboxId: req.sessionId, previewUrl });
    return seed;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Keep the sandbox record around in `error` state. Earlier
    // implementations destroyed the record here, which made the UI
    // think nothing happened AND freed the host port so the NEXT
    // provision reused it, colliding two sessions on the same port.
    // Tear the container down (so docker doesn't have a bad row) but
    // keep the in-memory record with its error visible until the user
    // explicitly retries or deletes the session.
    seed.status = 'error';
    seed.step = 'error';
    seed.error = message;
    deps.appendLog(seed, 'error', message);
    deps.persist(seed, 'error');
    deps.emit({ kind: 'error', sandboxId: req.sessionId, message });

    if (seed.containerId) {
      try {
        await deps.driver.destroy(seed.containerId);
        seed.containerId = '';
      } catch (cleanupErr) {
        deps.appendLog(
          seed,
          'error',
          `(also) cleanup destroy failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
        );
      }
    }
    throw e;
  }
}
