/**
 * Podman driver — `CliOciDriver` with Podman-specific defaults.
 *
 * Rationale for choosing Podman when available:
 *   - Rootless by default. The container's root UID maps to an
 *     unprivileged host UID via user namespaces, which hardens us against
 *     arbitrary-code execution by the LLM inside the sandbox.
 *   - No long-running daemon. `podman` invocations fork-and-exit,
 *     reducing the attack surface vs. the Docker daemon.
 *   - Docker-compatible CLI: the base driver works unchanged.
 *
 * Notes:
 *   - `podman run --userns=keep-id` is intentionally NOT added here.
 *     Without it, the container root is mapped to the host user, which
 *     is actually what we want for `podman cp` to write files the host
 *     user can read. Adding `keep-id` would break that on rootless setups.
 *   - On Windows with Podman Desktop, the CLI transparently proxies to
 *     a WSL2 vm; no special flags needed.
 */

import { defaultLocalShellPort } from '@mcp/code-agent/ports/shell-port.js';
import type { IShellPort } from '@mcp/code-agent/ports/shell-port.js';
import { CliOciDriver } from './cli-oci-driver.js';

export interface PodmanDriverOptions {
  /** Path to the podman binary. Defaults to `podman`. */
  binary?: string;
  shell?: IShellPort;
}

export class PodmanDriver extends CliOciDriver {
  constructor(options: PodmanDriverOptions = {}) {
    super({
      runtime: 'podman',
      binary: options.binary ?? 'podman',
      shell: options.shell ?? defaultLocalShellPort(),
    });
  }
}
