/**
 * NetworkController — provisions the shared network + egress proxy that
 * sandbox containers join when the egress firewall is enabled.
 *
 * Why:
 *   Sandbox containers run arbitrary code. If they can talk to anything
 *   on the internet, an LLM-authored npm package post-install hook could
 *   exfiltrate credentials, call home, or fetch follow-up payloads.
 *   Joining a network with `internal: true` blocks direct egress; a
 *   squid sidecar on the same network provides gated egress to a curated
 *   allowlist (see `docker/sandbox-squid/squid.conf`).
 *
 * Lifecycle:
 *   - `ensure()` is idempotent. First call per process:
 *       1. Creates `mcp-sandbox-net` with `--internal` (no default route).
 *       2. Runs `mcp-sandbox-squid` attached to that network.
 *       3. Returns `{ networkName, proxyUrl }` suitable for feeding
 *          `SandboxIsolation.network` and `.httpProxy`.
 *   - Subsequent calls reuse the discovered state.
 *   - Enablement is env-driven via `MCP_SANDBOX_EGRESS_FIREWALL=1`. When
 *     disabled (default), `ensure()` returns `null` and sandboxes use
 *     whatever `SandboxIsolation` says (usually the runtime's default
 *     bridge with direct egress — convenient for dev, not for prod).
 *
 * Non-goals:
 *   - We don't MITM TLS. The squid policy uses `dstdomain` ACLs on the
 *     SNI / Host header; traffic is tunneled via CONNECT.
 *   - We don't build the squid image here. Operators must
 *     `docker build -t mcp-sandbox-squid:latest docker/sandbox-squid/`
 *     (or pull a pre-built tag) before enabling the firewall. `ensure()`
 *     surfaces a clear error if the image is absent.
 */

import type { IShellPort } from '@mcp/code-agent/ports/shell-port.js';
import { defaultLocalShellPort } from '@mcp/code-agent/ports/shell-port.js';

export interface NetworkInfo {
  networkName: string;
  /** URL the sandbox can reach from inside the network. */
  proxyUrl: string;
}

export interface NetworkControllerOptions {
  /** OCI binary — `docker` or `podman`. Must match the driver's choice. */
  binary?: string;
  shell?: IShellPort;
  /** Network name. Default `mcp-sandbox-net`. */
  networkName?: string;
  /** Squid container name. Default `mcp-sandbox-squid`. */
  proxyContainerName?: string;
  /** Squid image tag. Default `mcp-sandbox-squid:latest`. */
  proxyImage?: string;
  /** Squid listens here inside the network. Default 3128. */
  proxyPort?: number;
}

export class NetworkController {
  private readonly binary: string;
  private readonly shell: IShellPort;
  private readonly networkName: string;
  private readonly proxyContainerName: string;
  private readonly proxyImage: string;
  private readonly proxyPort: number;
  private ensured: Promise<NetworkInfo | null> | null = null;

  constructor(options: NetworkControllerOptions = {}) {
    this.binary = options.binary ?? process.env.MCP_SANDBOX_BINARY ?? 'docker';
    this.shell = options.shell ?? defaultLocalShellPort();
    this.networkName = options.networkName ?? 'mcp-sandbox-net';
    this.proxyContainerName = options.proxyContainerName ?? 'mcp-sandbox-squid';
    this.proxyImage = options.proxyImage ?? 'mcp-sandbox-squid:latest';
    this.proxyPort = options.proxyPort ?? 3128;
  }

  /**
   * Entry point. Returns `null` when the egress firewall is disabled
   * via env — callers that got `null` should leave isolation.network
   * and isolation.httpProxy at their own defaults.
   *
   * Memoized: the first successful call caches the result, so the
   * manager only pays the existence-check cost once per process.
   */
  async ensure(): Promise<NetworkInfo | null> {
    if (process.env.MCP_SANDBOX_EGRESS_FIREWALL !== '1') return null;
    if (!this.ensured) this.ensured = this.doEnsure();
    return this.ensured;
  }

  // ────────────────────────────────────────────────────────── internals

  private async doEnsure(): Promise<NetworkInfo> {
    await this.ensureNetwork();
    await this.ensureProxyContainer();
    return {
      networkName: this.networkName,
      // Inside the shared docker network, the sandbox resolves the
      // proxy container by its name via the default embedded DNS.
      // `http://<name>:<port>` is the canonical URL form.
      proxyUrl: `http://${this.proxyContainerName}:${this.proxyPort}`,
    };
  }

  private async ensureNetwork(): Promise<void> {
    // `<bin> network inspect` returns non-zero when the network is
    // missing. We create it with `--internal` (no default route) so
    // sandboxes MUST go through the proxy to reach anything external.
    const inspect = await this.shell.run(this.binary, ['network', 'inspect', this.networkName], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });
    if (inspect.exitCode === 0) return;
    const create = await this.shell.run(
      this.binary,
      ['network', 'create', '--internal', this.networkName],
      { cwd: process.cwd(), encoding: 'utf-8' },
    );
    if (create.exitCode !== 0) {
      throw new Error(
        `Failed to create sandbox network '${this.networkName}': ${create.stderr.trim()}`,
      );
    }
  }

  private async ensureProxyContainer(): Promise<void> {
    // A running container by the same name short-circuits.
    const inspect = await this.shell.run(
      this.binary,
      ['inspect', '--format', '{{.State.Running}}', this.proxyContainerName],
      { cwd: process.cwd(), encoding: 'utf-8' },
    );
    if (inspect.exitCode === 0 && inspect.stdout.trim() === 'true') return;

    // Stopped container? Remove so we start a fresh one with the
    // current config.
    if (inspect.exitCode === 0) {
      await this.shell.run(this.binary, ['rm', '-f', this.proxyContainerName], {
        cwd: process.cwd(),
        encoding: 'utf-8',
      });
    }

    // Image check: surface a clear error before a cryptic `run` failure.
    const imageCheck = await this.shell.run(
      this.binary,
      ['image', 'inspect', this.proxyImage],
      { cwd: process.cwd(), encoding: 'utf-8' },
    );
    if (imageCheck.exitCode !== 0) {
      throw new Error(
        `Egress proxy image '${this.proxyImage}' not found. Build it once with ` +
          `\`${this.binary} build -t ${this.proxyImage} docker/sandbox-squid\` ` +
          `or disable the firewall by unsetting MCP_SANDBOX_EGRESS_FIREWALL.`,
      );
    }

    const run = await this.shell.run(
      this.binary,
      [
        'run',
        '-d',
        '--name', this.proxyContainerName,
        '--network', this.networkName,
        '--restart=always',
        '--label', 'mcp.sandbox.proxy=1',
        this.proxyImage,
      ],
      { cwd: process.cwd(), encoding: 'utf-8' },
    );
    if (run.exitCode !== 0) {
      throw new Error(
        `Failed to start sandbox egress proxy: ${run.stderr.trim() || run.stdout.trim()}`,
      );
    }
  }
}

let singleton: NetworkController | null = null;
export function getNetworkController(): NetworkController {
  if (!singleton) singleton = new NetworkController();
  return singleton;
}

export function setNetworkControllerForTests(nc: NetworkController | null): void {
  singleton = nc;
}
