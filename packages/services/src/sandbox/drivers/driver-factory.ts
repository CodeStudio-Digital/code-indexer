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

import { defaultLocalShellPort } from '@mcp/code-agent/ports/shell-port.js';
import type { IShellPort } from '@mcp/code-agent/ports/shell-port.js';
import type { ISandboxDriver } from '../ports/sandbox-driver.js';
import { DockerDriver } from './docker-driver.js';
import { PodmanDriver } from './podman-driver.js';
import { E2BDriver } from './e2b-driver.js';
import { probeBinaryVersion } from './probe.js';

export type SandboxRuntimeChoice = 'docker' | 'podman' | 'e2b' | 'auto';

export interface ResolveDriverOptions {
  runtime?: SandboxRuntimeChoice;
  shell?: IShellPort;
}

let cached: ISandboxDriver | null = null;
let autoFellBackToE2B = false;

/** Test hook. Swapping the singleton between tests is allowed. */
export function setDriverForTests(driver: ISandboxDriver | null): void {
  cached = driver;
  autoFellBackToE2B = false;
}

/**
 * True when `auto` resolution found NO local container runtime and fell back
 * to the E2B stub. Observational only (doesn't change behavior) — the first-run
 * preflight wizard is the user-facing gate; this getter lets callers surface a
 * pointer back to it instead of the late, opaque E2B "missing SDK" error.
 */
export function didAutoFallBackToE2B(): boolean {
  return autoFellBackToE2B;
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
  autoFellBackToE2B = true;
  console.warn('[sandbox] no local container runtime (Podman/Docker) found; using E2B stub — run first-run preflight.');
  cached = new E2BDriver();
  return cached;
}

async function canInvoke(shell: IShellPort, binary: string): Promise<boolean> {
  // Delegates to the shared probe (probe.ts) so driver selection and the
  // first-run preflight checks share one liveness definition.
  return (await probeBinaryVersion(shell, binary)).present;
}
