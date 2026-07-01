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
import type { InstallProgress, Runtime, RuntimeApi, RuntimeKind, RuntimeRelease, RuntimeTarget } from '@mcp/api-bus';
import type { HandlerDeps } from '../types.js';
import { detectNodeRuntimes } from './detect-node.js';
import * as nodeManager from './node-manager.js';
import * as phpManager from './php-manager.js';
import * as pythonManager from './python-manager.js';
import { detectWslRuntimes } from './wsl-runtime.js';
import { installWslRuntime, listWslReleases, uninstallWslRuntime } from './wsl-install.js';

export function createRuntimeHandlers(_deps: HandlerDeps): RuntimeApi {
  const dir = (): string => ensureDataDir();

  function listFor(kind: RuntimeKind): Runtime[] {
    if (kind === 'node') return detectNodeRuntimes(dir());
    if (kind === 'php') return phpManager.detect(dir());
    if (kind === 'python') return pythonManager.detect(dir());
    throw new ApiError('unsupported', 400, `unknown runtime kind: ${kind}`);
  }

  function releasesFor(kind: RuntimeKind): Promise<RuntimeRelease[]> {
    if (kind === 'node') return nodeManager.listAvailable();
    if (kind === 'php') return phpManager.listReleases();
    if (kind === 'python') return pythonManager.listReleases();
    throw new ApiError('unsupported', 400, `unknown runtime kind: ${kind}`);
  }

  function installFor(kind: RuntimeKind, version: string): AsyncGenerator<InstallProgress> {
    if (kind === 'node') return nodeManager.download(version, dir());
    if (kind === 'php') return phpManager.install(version, dir());
    if (kind === 'python') return pythonManager.install(version, dir());
    throw new ApiError('unsupported', 400, `unknown runtime kind: ${kind}`);
  }

  function uninstallFor(kind: RuntimeKind, version: string): Promise<void> {
    if (kind === 'node') return nodeManager.remove(version, dir());
    if (kind === 'php') return phpManager.uninstall(version, dir());
    if (kind === 'python') return pythonManager.uninstall(version, dir());
    throw new ApiError('unsupported', 400, `unknown runtime kind: ${kind}`);
  }

  /** Narrow a target to its WSL distro, or null for the host (default). */
  function wslDistro(target: RuntimeTarget | undefined): string | null {
    return target?.kind === 'wsl' ? target.distro : null;
  }

  return {
    async list({ kind, target }) {
      const distro = wslDistro(target);
      return distro ? detectWslRuntimes(kind, distro) : listFor(kind);
    },
    async listReleases({ kind, target }) {
      const distro = wslDistro(target);
      return distro ? listWslReleases(kind, distro) : releasesFor(kind);
    },
    install({ kind, version, target }) {
      const distro = wslDistro(target);
      return distro ? installWslRuntime(kind, version, distro) : installFor(kind, version);
    },
    async uninstall({ kind, version, target }) {
      const distro = wslDistro(target);
      if (distro) await uninstallWslRuntime(kind, version, distro);
      else await uninstallFor(kind, version);
    },

    // ── PHP extensions ──
    async listExtensions({ version }) {
      return phpManager.listExtensions(version, dir());
    },
    async setExtension({ version, name, enabled }) {
      phpManager.setExtension(version, name, enabled, dir());
    },
    installPeclExtension({ version, name }) {
      return phpManager.installPeclExtension(version, name, dir());
    },
  };
}
