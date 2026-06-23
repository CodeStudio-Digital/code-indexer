/**
 * Live-sandbox lifecycle operations — restart, recover, pause, resume,
 * and start (after pause). These all assume a container already exists
 * for the session/service; provisioning new containers is a separate
 * concern handled by `provision()` / `provisionAdditionalService()`.
 *
 * Extracted from `SandboxManager` so the dev-server's "what should I
 * relaunch when the user clicks Restart / Resume / Play?" decision tree
 * lives in one file and can be tested with a fake driver + registry.
 *
 * The deps bag is intentionally wide: every method here needs the
 * registry, driver, port allocator, status emitter, persist hooks,
 * env sync hooks, AND the dev-server runtime helpers. The shape makes
 * the dependency graph explicit — every callable surface that previously
 * lived on `this.` is enumerated here.
 */
import { saveArchive } from '@mcp/services/sandbox/archive.js';
import type {
  Sandbox,
  SandboxEvent,
  SandboxStack,
} from '@mcp/services/sandbox/types.js';
import type { ISandboxDriver } from '@mcp/services/sandbox/ports/sandbox-driver.js';
import type { PersistedSandboxStatus } from '@mcp/store/company-sandbox-store.js';
import type { SandboxRegistry } from '@mcp/services/sandbox/manager/state/registry.js';
import { previewPathPrefixOf } from '@mcp/services/sandbox/manager/util/preview-url.js';
import {
  relaunchDevServer,
  waitForPublishedHttp,
} from '@mcp/services/sandbox/manager/dev-server-runtime.js';
import {
  resolveExternalNodeDevSpec,
  startExternalNodeDevServer,
  type ExternalNodeRuntimeDeps,
} from '@mcp/services/sandbox/manager/external-node-runtime.js';

export interface DevLifecycleDeps {
  registry: SandboxRegistry;
  getDriver: () => ISandboxDriver | null;
  resolveDriverOnce: () => Promise<ISandboxDriver>;
  reservePort: (port: number) => Promise<void>;
  releasePort: (port: number) => void;
  devServerPort: number;
  appendLog: (sb: Sandbox, level: 'info' | 'error', text: string) => void;
  emit: (event: SandboxEvent) => void;
  recordStep: (sb: Sandbox, step: Sandbox['step'], message: string) => void;
  persist: (sb: Sandbox, statusOverride?: PersistedSandboxStatus) => void;
  persistService: (
    sessionId: string,
    serviceId: string,
    name: string,
    sb: Sandbox,
    status: PersistedSandboxStatus,
  ) => void;
  syncManagedEnvs: (sessionId: string) => void;
  syncEnvsToAllContainers: (sessionId: string) => Promise<void>;
  unpauseRuntimeContainer: (sessionId: string, serviceId: string) => Promise<Sandbox>;
  /** Deps for `startExternalNodeDevServer` — usually `{ appendLog, recordStep }`. */
  externalNodeRuntimeDeps: ExternalNodeRuntimeDeps;
}

// ─── restartDevServer ───────────────────────────────────────────

/**
 * Kill `vite|node` and relaunch with the canonical proxy-aware config.
 * Used by the dashboard's "Restart dev-server" button when the iframe
 * shows ECONNREFUSED but the container is still alive. Preserves every
 * file in the workdir; only `vite.config.ts` is regenerated.
 *
 * Refuses to run on external-mount sandboxes and Dockerfile-built
 * containers — those have their own dev-server contract.
 */
export async function restartDevServer(
  sessionId: string,
  deps: DevLifecycleDeps,
): Promise<void> {
  const sb = deps.registry.getPrimary(sessionId);
  if (!sb || !sb.containerId || !deps.getDriver()) {
    throw new Error(`No running sandbox for session ${sessionId}`);
  }
  if (sb.runtimePaused) {
    throw new Error(`Cannot restart dev-server while session ${sessionId} is runtime-paused`);
  }
  if (sb.mountKind === 'external') {
    throw new Error('External project containers should be recreated with Retry so package.json/Dockerfile metadata is re-read.');
  }
  if (sb.imageSource === 'project_dockerfile') {
    throw new Error('Project Dockerfile containers use their image CMD/ENTRYPOINT; use Retry to rebuild/recreate.');
  }
  deps.appendLog(sb, 'info', 'Restart requested — killing dev-server and relaunching…');
  await recoverDevServer(sb, deps);
  sb.step = 'ready';
  sb.lastAccessAt = Date.now();
  deps.appendLog(sb, 'info', 'Dev server restarted.');
  deps.emit({ kind: 'ready', sandboxId: sb.id, previewUrl: sb.previewUrl });
}

// ─── recoverDevServer ───────────────────────────────────────────

/**
 * Workdir-preserving dev-server recovery: kill `vite|node`, re-render
 * the proxy-aware `vite.config.ts`, and relaunch. Only `vite.config.ts`
 * is rewritten; every other file in the workdir survives.
 *
 * Shared between `restartDevServer` (manual) and `resumeSandbox` (fallback
 * when the initial relaunch fails).
 */
export async function recoverDevServer(
  sb: Sandbox,
  deps: DevLifecycleDeps,
): Promise<void> {
  const driver = deps.getDriver();
  if (!sb.containerId || !driver) {
    throw new Error(`No running sandbox for session ${sb.id}`);
  }
  if (sb.mountKind === 'external') {
    throw new Error('External project containers cannot use MCP dev-server recovery.');
  }
  if (sb.imageSource === 'project_dockerfile') {
    throw new Error('Project Dockerfile containers cannot use MCP dev-server recovery.');
  }

  // Kill every `node`/`vite` PID. `pkill` exits non-zero when nothing
  // matches; we tolerate that case.
  await driver.exec(sb.containerId, `pkill -f 'vite|node' 2>/dev/null || true`, {
    cwd: undefined,
    timeoutMs: 5_000,
  });

  // Re-write the proxy-aware vite.config.ts. If the agent replaced it
  // with a default one, the dev server would bind only to 127.0.0.1
  // inside the container and the host port-forward would fail with
  // ECONNREFUSED. We use the same renderer the scaffolder uses.
  const { renderViteConfig } = await import('@mcp/services/sandbox/scaffolders/vite-scaffolder-base.js');
  const previewPathPrefix = previewPathPrefixOf(sb.previewUrl);
  const cfg = renderViteConfig({
    base: previewPathPrefix,
    hmrPath: `${previewPathPrefix.replace(/\/$/, '')}/@vite/hmr`,
    devPort: deps.devServerPort,
    // Re-apply the Builder source-stamp (if any) so element selection
    // survives config regeneration. Undefined for non-Builder sandboxes.
    stamp: sb.viteStamp,
  });
  await driver.writeFile(sb.containerId, `${sb.workdir}/vite.config.ts`, cfg, {
    recursive: true,
  });

  sb.step = 'starting-dev-server';
  deps.emit({
    kind: 'step',
    sandboxId: sb.id,
    step: 'starting-dev-server',
    message: 'Relaunching dev server…',
  });
  await relaunchDevServer(driver, sb.containerId, sb.workdir, sb.stack, deps.devServerPort);
}

// ─── pauseSandbox ───────────────────────────────────────────────

/**
 * Soft eviction: `podman stop` the container but keep it around.
 * Filesystem layer is preserved so `resumeSandbox` is instant.
 * Idempotent — calling on an already-paused sandbox is a no-op.
 *
 * Pre-pause archive: bind-mount sandboxes skip the tar export (host
 * filesystem already persists everything); others archive their
 * workdir so a hard runtime reset can replay it on resume.
 */
export async function pauseSandbox(
  sessionId: string,
  reason: string,
  deps: DevLifecycleDeps,
): Promise<void> {
  const sb = deps.registry.getPrimary(sessionId);
  if (!sb) return;
  if (sb.status === 'paused') return;
  if (sb.runtimePaused) return;
  if (sb.status !== 'ready') {
    // Can't pause provisioning/error sandboxes. Let them resolve first.
    return;
  }
  const driver = deps.getDriver();
  if (!driver || !sb.containerId) return;

  deps.appendLog(sb, 'info', `Pausing (reason: ${reason})…`);

  if (!sb.hostWorkdirMount) {
    try {
      const tar = await driver.exportWorkdir(sb.containerId, sb.workdir);
      if (tar && tar.byteLength > 0) {
        await saveArchive(sb.id, tar);
        deps.appendLog(sb, 'info', `Archived workdir (${tar.byteLength} bytes) before pause.`);
      }
    } catch (e) {
      console.warn(
        `[sandbox-manager] pre-pause archive ${sb.id} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  try {
    await driver.stopContainer(sb.containerId, 5);
  } catch (e) {
    deps.appendLog(
      sb,
      'error',
      `Pause failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }
  sb.status = 'paused';
  sb.runtimePaused = false;
  sb.step = 'queued';
  deps.releasePort(sb.hostPort);
  deps.persist(sb, 'paused');
  deps.emit({ kind: 'paused', sandboxId: sb.id, reason });
  console.log(
    `[sandbox-manager] paused session=${sb.id} container=${sb.containerId.slice(0, 12)} reason=${reason}`,
  );
}

// ─── resumeSandbox ──────────────────────────────────────────────

/**
 * Wake a paused sandbox: `podman start` + relaunch the dev server.
 * Cheap (~5s) compared to re-provisioning from archive (~90s). Preserves
 * every file + `node_modules` + cached deps the agent produced.
 *
 * Dev-server relaunch branches by stack type:
 *   - project_dockerfile → wait for HTTP on `/`
 *   - external mount     → external Node dev server with package.json
 *   - default            → relaunch the scaffolded Vite/Wrangler dev
 *                          server; falls back to `recoverDevServer` if
 *                          the relaunch fails.
 */
export async function resumeSandbox(
  sessionId: string,
  deps: DevLifecycleDeps,
): Promise<Sandbox> {
  const sb = deps.registry.getPrimary(sessionId);
  if (!sb) throw new Error(`No sandbox for session ${sessionId}`);
  if (sb.status === 'ready') return sb;
  if (sb.status !== 'paused') {
    throw new Error(`Cannot resume session ${sessionId} from status '${sb.status}'`);
  }
  const driver = deps.getDriver();
  if (!driver || !sb.containerId) throw new Error('No driver or container id');

  deps.appendLog(sb, 'info', 'Resuming from paused state…');
  deps.recordStep(sb, 'starting-dev-server', 'Starting container…');

  await driver.startContainer(sb.containerId);
  sb.runtimePaused = false;
  // Re-reserve the port: `podman start` re-binds the mapping we set
  // at create time, so the same port comes back. Mirror in the allocator.
  await deps.reservePort(sb.hostPort);

  deps.recordStep(sb, 'starting-dev-server', 'Relaunching dev server…');
  if (sb.imageSource === 'project_dockerfile') {
    await waitForPublishedHttp(driver, sb, '/');
  } else if (sb.mountKind === 'external') {
    if (!sb.hostWorkdirMount) {
      throw new Error('External Node project is missing its host project root.');
    }
    const spec = resolveExternalNodeDevSpec(
      sb.hostWorkdirMount,
      sb.stack,
      sb.containerPort,
      deps.devServerPort,
    );
    await startExternalNodeDevServer(driver, sb, spec, deps.externalNodeRuntimeDeps);
  } else {
    try {
      await relaunchDevServer(driver, sb.containerId, sb.workdir, sb.stack, deps.devServerPort);
    } catch (e) {
      deps.appendLog(
        sb,
        'info',
        `Resume relaunch failed (${e instanceof Error ? e.message : String(e)}). Falling back to full dev-server recovery…`,
      );
      await recoverDevServer(sb, deps);
    }
  }

  sb.status = 'ready';
  sb.step = 'ready';
  sb.lastAccessAt = Date.now();
  deps.appendLog(sb, 'info', 'Resumed successfully.');
  deps.persist(sb, 'running');
  deps.emit({ kind: 'resumed', sandboxId: sb.id, previewUrl: sb.previewUrl });
  deps.syncManagedEnvs(sessionId);
  return sb;
}

// ─── startServiceContainer ──────────────────────────────────────

/**
 * Start (or unpause) a secondary service container that was previously
 * provisioned. Idempotent — returns the existing sandbox unchanged when
 * already `ready`. Unpauses runtime-paused containers via the existing
 * `unpauseRuntimeContainer` path; the genuinely-stopped case goes
 * through the dev-server relaunch dance.
 */
export async function startServiceContainer(
  sessionId: string,
  serviceId: string,
  deps: DevLifecycleDeps,
): Promise<Sandbox> {
  const sb = deps.registry.getService(sessionId, serviceId);
  if (!sb) throw new Error(`No service '${serviceId}' for session ${sessionId}`);
  if (sb.status === 'ready' && !sb.runtimePaused) return sb;
  if (sb.runtimePaused) return await deps.unpauseRuntimeContainer(sessionId, serviceId);
  if (sb.status !== 'paused') {
    throw new Error(`Cannot start service '${serviceId}' from status '${sb.status}'`);
  }
  const driver = await deps.resolveDriverOnce();
  if (!sb.containerId) throw new Error(`No container id for ${sb.id}`);

  const inspect = await driver.inspectContainer(sb.containerId);
  if (!inspect.exists) throw new Error(`Container for ${sb.id} no longer exists`);
  if (inspect.paused) {
    await driver.unpauseContainer(sb.containerId);
  } else if (!inspect.running) {
    deps.recordStep(sb, 'starting-dev-server', 'Starting container...');
    await driver.startContainer(sb.containerId);
    await deps.reservePort(sb.hostPort);
  }

  deps.recordStep(sb, 'starting-dev-server', 'Starting dev server...');
  if (sb.imageSource === 'project_dockerfile') {
    await waitForPublishedHttp(driver, sb, '/');
  } else if (sb.mountKind === 'external') {
    if (!sb.hostWorkdirMount) {
      throw new Error('External Node service is missing its host project root.');
    }
    const spec = resolveExternalNodeDevSpec(
      sb.hostWorkdirMount,
      sb.stack as SandboxStack,
      sb.containerPort,
      deps.devServerPort,
    );
    await startExternalNodeDevServer(driver, sb, spec, deps.externalNodeRuntimeDeps);
  } else {
    await relaunchDevServer(driver, sb.containerId, sb.workdir, sb.stack, deps.devServerPort);
  }

  sb.status = 'ready';
  sb.runtimePaused = false;
  sb.step = 'ready';
  sb.error = undefined;
  sb.lastAccessAt = Date.now();
  deps.appendLog(sb, 'info', 'Service started.');
  deps.persistService(sessionId, serviceId, serviceId, sb, 'running');
  deps.emit({ kind: 'ready', sandboxId: sb.id, previewUrl: sb.previewUrl });
  deps.syncManagedEnvs(sessionId);
  void deps.syncEnvsToAllContainers(sessionId).catch(() => void 0);
  return sb;
}
