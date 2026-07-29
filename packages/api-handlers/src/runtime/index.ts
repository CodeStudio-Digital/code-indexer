/**
 * Handlers for the `runtime` namespace — per-project toolchains (Node, PHP,
 * Python). Detection + install/uninstall dispatch per-kind to the managers in
 * this folder; PHP extension management lives in php-extensions.ts / php-pecl.ts.
 *
 * The terminal and runner handlers consult `resolveProjectRuntimeEnv`
 * (runtime-resolve.ts) to put the project's chosen runtimes on PATH at spawn.
 */

import { ensureDataDir } from '@mcp/shared/utils/config.js';
import { ApiError } from '@mcp/api-bus';
import type { InstallProgress, RuntimeApi, RuntimeKind, RuntimeRelease, RuntimeTarget } from '@mcp/api-bus';
import { getLspServerManager } from '@mcp/services/lsp/lsp-server-manager.js';
import type { HandlerDeps } from '../types.js';
import { detectRuntimes } from './detect-runner.js';
import * as nodeManager from './node-manager.js';
import * as phpManager from './php-manager.js';
import * as pythonManager from './python-manager.js';
import * as jdkManager from './jdk-manager.js';
import * as dotnetManager from './dotnet-manager.js';
import { detectWslRuntimes } from './wsl-runtime.js';
import { installWslRuntime, listWslReleases, uninstallWslRuntime } from './wsl-install.js';
import { assertRuntimeVersion } from './runtime-version.js';
import { invalidateLspRuntimeCache } from '../lsp/lsp-runtime.js';
import { refreshAfterSuccessfulPhpExtensionInstall, refreshRunningIntelephense } from './php-lsp-sync.js';

export function createRuntimeHandlers(deps: HandlerDeps): RuntimeApi {
  const dir = (): string => ensureDataDir();

  function releasesFor(kind: RuntimeKind): Promise<RuntimeRelease[]> {
    if (kind === 'node') return nodeManager.listAvailable();
    if (kind === 'php') return phpManager.listReleases();
    if (kind === 'python') return pythonManager.listReleases();
    if (kind === 'java') return jdkManager.listReleases();
    if (kind === 'dotnet') return dotnetManager.listReleases();
    throw new ApiError('unsupported', 400, `unknown runtime kind: ${kind}`);
  }

  function installFor(kind: RuntimeKind, version: string): AsyncGenerator<InstallProgress> {
    if (kind === 'node') return nodeManager.download(version, dir());
    if (kind === 'php') return phpManager.install(version, dir());
    if (kind === 'python') return pythonManager.install(version, dir());
    if (kind === 'java') return jdkManager.install(version, dir());
    if (kind === 'dotnet') return dotnetManager.install(version, dir());
    throw new ApiError('unsupported', 400, `unknown runtime kind: ${kind}`);
  }

  function uninstallFor(kind: RuntimeKind, version: string): Promise<void> {
    if (kind === 'node') return nodeManager.remove(version, dir());
    if (kind === 'php') return phpManager.uninstall(version, dir());
    if (kind === 'python') return pythonManager.uninstall(version, dir());
    if (kind === 'java') return jdkManager.uninstall(version, dir());
    if (kind === 'dotnet') return dotnetManager.uninstall(version, dir());
    throw new ApiError('unsupported', 400, `unknown runtime kind: ${kind}`);
  }

  /** Narrow a target to its WSL distro, or null for the host (default). */
  function wslDistro(target: RuntimeTarget | undefined): string | null {
    return target?.kind === 'wsl' ? target.distro : null;
  }

  return {
    async list({ kind, target }) {
      const distro = wslDistro(target);
      return distro ? detectWslRuntimes(kind, distro) : detectRuntimes(kind, dir());
    },
    async listReleases({ kind, target }) {
      const distro = wslDistro(target);
      return distro ? listWslReleases(kind, distro) : releasesFor(kind);
    },
    install({ kind, version, target }) {
      assertRuntimeVersion(version);
      const distro = wslDistro(target);
      const progress = distro ? installWslRuntime(kind, version, distro) : installFor(kind, version);
      // The LSP runtime resolver caches "no usable SDK" — a fresh install must
      // be visible on the very next acquire, not after the TTL.
      return (async function* invalidateAfter() {
        try {
          yield* progress;
        } finally {
          invalidateLspRuntimeCache();
        }
      })();
    },
    async uninstall({ kind, version, target }) {
      assertRuntimeVersion(version);
      const distro = wslDistro(target);
      if (distro) await uninstallWslRuntime(kind, version, distro);
      else await uninstallFor(kind, version);
      invalidateLspRuntimeCache();
    },

    // ── PHP extensions ──
    async listExtensions({ version }) {
      return phpManager.listExtensions(version, dir());
    },
    async setExtension({ version, name, enabled }) {
      phpManager.setExtension(version, name, enabled, dir());
      await refreshRunningIntelephense(deps.db, getLspServerManager(), version);
    },
    installPeclExtension({ version, name }) {
      return refreshAfterSuccessfulPhpExtensionInstall(
        phpManager.installPeclExtension(version, name, dir()),
        () => refreshRunningIntelephense(deps.db, getLspServerManager(), version),
      );
    },
  };
}
