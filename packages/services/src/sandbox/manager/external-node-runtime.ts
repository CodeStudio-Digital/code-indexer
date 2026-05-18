/**
 * Runtime side of "external Node" dev servers — user-supplied projects
 * (Vite, Next, Angular, generic) that we mount into a sandbox container
 * and boot via the project's own `package.json` `dev`/`start`/`serve`
 * script.
 *
 * Pure inference helpers (framework detection, port inference, install
 * command synthesis) live in `manager/external-node.ts`. THIS module
 * holds the side-effectful "spec from manifest", "ensure node_modules",
 * "spawn the dev server" steps that the manager used to keep inline.
 *
 * Extraction motivation: every method here touches `driver.exec` with a
 * specific timeout / cwd / env pattern. Centralising them lets a single
 * regression test confirm the contract (probe → install → probe →
 * spawn → wait-for-http) instead of re-asserting via the entire
 * `provision()` smoke.
 */
import type { Sandbox, SandboxStack } from '@mcp/services/sandbox/types.js';
import type { ISandboxDriver } from '@mcp/services/sandbox/ports/sandbox-driver.js';
import { detectManifest } from '@mcp/services/sandbox/manifest-detector/detect.js';
import { previewPathPrefixOf } from '@mcp/services/sandbox/manager/util/preview-url.js';
import { truncateForLog } from '@mcp/services/sandbox/manager/util/shell.js';
import {
  externalNodeDependencyProbeCommand,
  externalNodeInstallCommand,
  externalNodeRunCommand,
  inferExternalNodeFramework,
  inferExternalNodePort,
  inferExternalNodeScriptPort,
  type ExternalNodeDevSpec,
} from '@mcp/services/sandbox/manager/external-node.js';
import { waitForPublishedHttp } from '@mcp/services/sandbox/manager/dev-server-runtime.js';

/**
 * Build a complete `ExternalNodeDevSpec` from the user's package.json.
 * Resolves package manager, dev script, framework, and container port
 * — port precedence: explicit override > scripted port > framework
 * default > manager fallback (`defaultDevServerPort`).
 */
export function resolveExternalNodeDevSpec(
  hostWorkdirMount: string,
  stack: SandboxStack,
  portOverride: number | undefined,
  defaultDevServerPort: number,
): ExternalNodeDevSpec {
  const manifest = detectManifest(hostWorkdirMount);
  if (!manifest || manifest.kind !== 'node') {
    throw new Error(
      'External Node image mode requires a package.json with a dev/start/serve script.',
    );
  }
  const scriptName = manifest.devScriptName;
  if (!scriptName) {
    throw new Error(
      'External Node image mode requires package.json script "dev", "start", or "serve".',
    );
  }
  const scriptBody = manifest.scripts[scriptName] ?? '';
  const framework = inferExternalNodeFramework(stack, scriptBody);
  const scriptedPort = inferExternalNodeScriptPort(scriptBody);
  return {
    manifest,
    packageManager: manifest.packageManager,
    scriptName,
    scriptBody,
    containerPort:
      portOverride ?? scriptedPort ?? inferExternalNodePort(framework, defaultDevServerPort),
    framework,
  };
}

export interface ExternalNodeRuntimeDeps {
  /** Append a line to the sandbox's recent-logs ring buffer. */
  appendLog: (sb: Sandbox, level: 'info' | 'error', text: string) => void;
  /** Record a transition in the SandboxStep state machine + emit. */
  recordStep: (sb: Sandbox, step: Sandbox['step'], message: string) => void;
}

/**
 * Probe for an installed `node_modules`; install via the project's
 * package manager if missing or corrupted; probe again to verify.
 * Throws a descriptive error on install failure so the user sees the
 * exact npm/pnpm/yarn output.
 */
export async function ensureExternalNodeDependencies(
  driver: ISandboxDriver,
  sb: Sandbox,
  spec: ExternalNodeDevSpec,
  deps: ExternalNodeRuntimeDeps,
  signal?: AbortSignal,
): Promise<void> {
  const probeCommand = externalNodeDependencyProbeCommand();
  const installProbe = await driver.exec(
    sb.containerId,
    probeCommand,
    { cwd: sb.workdir, timeoutMs: 10_000, signal },
  );
  if (installProbe.exitCode === 0) {
    deps.appendLog(sb, 'info', 'Using existing node_modules from the external project.');
    return;
  }

  deps.recordStep(
    sb,
    'installing-deps',
    `Installing dependencies (${spec.packageManager} install)…`,
  );
  const installRes = await driver.exec(
    sb.containerId,
    externalNodeInstallCommand(spec.packageManager),
    { cwd: sb.workdir, timeoutMs: 420_000, signal, env: { CI: '1' } },
  );
  if (installRes.exitCode !== 0) {
    throw new Error(
      `${spec.packageManager} install failed (exit ${installRes.exitCode}): ${truncateForLog(installRes.stderr || installRes.stdout, 1_200)}`,
    );
  }

  const postInstallProbe = await driver.exec(
    sb.containerId,
    probeCommand,
    { cwd: sb.workdir, timeoutMs: 10_000, signal },
  );
  if (postInstallProbe.exitCode !== 0) {
    throw new Error(
      `dependency probe failed after ${spec.packageManager} install: ${truncateForLog(postInstallProbe.stderr || postInstallProbe.stdout, 1_200)}`,
    );
  }
}

/**
 * Boot the dev server via the project's own script — pnpm/yarn/npm run
 * <dev> with corepack toggled for non-npm managers. Waits for HTTP
 * `/` to return < 500 (or the scaffolder's "ready" banner) before
 * resolving. Throws with the dev-server log tail on timeout.
 */
export async function startExternalNodeDevServer(
  driver: ISandboxDriver,
  sb: Sandbox,
  spec: ExternalNodeDevSpec,
  deps: ExternalNodeRuntimeDeps,
  signal?: AbortSignal,
): Promise<void> {
  await ensureExternalNodeDependencies(driver, sb, spec, deps, signal);

  deps.recordStep(
    sb,
    'starting-dev-server',
    `Starting ${spec.packageManager} run ${spec.scriptName} on port ${spec.containerPort}…`,
  );
  const previewPath = previewPathPrefixOf(sb.previewUrl);
  const command = `nohup ${externalNodeRunCommand(spec, previewPath)} > /tmp/dev-server.log 2>&1 &`;
  const spawnRes = await driver.exec(sb.containerId, command, {
    cwd: sb.workdir,
    timeoutMs: 10_000,
    signal,
    env: {
      HOST: '0.0.0.0',
      PORT: String(spec.containerPort),
    },
  });
  if (spawnRes.exitCode !== 0) {
    throw new Error(`failed to launch external Node dev server: ${spawnRes.stderr || spawnRes.stdout}`);
  }

  await waitForPublishedHttp(driver, sb, '/', {
    signal,
    label: 'External Node dev server',
    timeoutMs: 180_000,
  });
}
