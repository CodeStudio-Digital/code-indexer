/**
 * Driver factory — picks an `ISandboxDriver` for the current process.
 *
 * Selection rules (in order):
 *   1. Explicit `options.runtime` (used by tests).
 *   2. `MCP_SANDBOX_RUNTIME` env: `docker` | `podman` | `e2b` | `auto`.
 *   3. Default `auto`, which probes in order Podman → Docker → E2B and
 *      picks the first whose binary answers `<bin> version`.
 *
 * Probing is done ONCE at process start. The resulting driver is cached
 * as a singleton — changing the env after boot has no effect (this
 * matches how other singletons like the LocalShellAdapter behave).
 *
 * Callers that must override for tests should use
 * `setDriverForTests(driver)` rather than mutating env.
 */

import { defaultLocalShellPort } from '../../coder/ports/shell-port.js';
import type { IShellPort } from '../../coder/ports/shell-port.js';
import type { ISandboxDriver } from '../ports/sandbox-driver.js';
import { DockerDriver } from './docker-driver.js';
import { PodmanDriver } from './podman-driver.js';
import { E2BDriver } from './e2b-driver.js';

export type SandboxRuntimeChoice = 'docker' | 'podman' | 'e2b' | 'auto';

export interface ResolveDriverOptions {
  runtime?: SandboxRuntimeChoice;
  shell?: IShellPort;
}

let cached: ISandboxDriver | null = null;

/** Test hook. Swapping the singleton between tests is allowed. */
export function setDriverForTests(driver: ISandboxDriver | null): void {
  cached = driver;
}

/**
 * Read-only accessor to the resolved runtime kind, or `null` when the
 * factory hasn't been called yet. Lets unrelated subsystems
 * (e.g. the QA endpoint that needs to address the host from inside a
 * container) pick host aliases without re-implementing the probe.
 */
export function getResolvedRuntime(): 'docker' | 'podman' | 'e2b' | null {
  return cached?.runtime ?? null;
}

export async function resolveDriver(
  options: ResolveDriverOptions = {},
): Promise<ISandboxDriver> {
  if (cached) return cached;

  const choice: SandboxRuntimeChoice =
    options.runtime ??
    (((process.env.MCP_SANDBOX_RUNTIME as SandboxRuntimeChoice | undefined) ?? 'auto'));
  const shell = options.shell ?? defaultLocalShellPort();

  if (choice === 'docker') {
    cached = new DockerDriver({ shell });
    return cached;
  }
  if (choice === 'podman') {
    cached = new PodmanDriver({ shell });
    return cached;
  }
  if (choice === 'e2b') {
    cached = new E2BDriver();
    return cached;
  }

  // auto: prefer Podman (rootless, lighter) → Docker → E2B.
  if (await canInvoke(shell, 'podman')) {
    cached = new PodmanDriver({ shell });
    return cached;
  }
  if (await canInvoke(shell, 'docker')) {
    cached = new DockerDriver({ shell });
    return cached;
  }
  // Last resort: E2B stub. `create()` throws with an actionable message;
  // we intentionally don't fail here so the app still boots and the
  // error surfaces only when a sandbox is requested.
  cached = new E2BDriver();
  return cached;
}

async function canInvoke(shell: IShellPort, binary: string): Promise<boolean> {
  try {
    const r = await shell.run(binary, ['version', '--format', '{{.Client.Version}}'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });
    // Podman respects --format but older versions may not; fall back to
    // non-zero-but-recognizable output as a liveness proof.
    return r.exitCode === 0 || /version/i.test(`${r.stdout}${r.stderr}`);
  } catch {
    return false;
  }
}
