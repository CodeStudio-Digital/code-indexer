import { existsSync, rmSync } from 'node:fs';
import { spawn as spawnChild } from 'node:child_process';
import type { SandboxMountKind } from '../../types.js';
import { resolveDriver } from '../../drivers/driver-factory.js';
import { resolveHostWorkdirMount } from '../io/env-helpers.js';
import { nodeModulesVolumeFor } from '../util/naming.js';

/**
 * Clean up per-session persistence state: the bind-mount host dir AND
 * the named `node_modules` volume. Invoked from the DELETE /sessions
 * handler after the container has already been destroyed. Best effort
 * — failures are logged, not thrown (session deletion should not be
 * blocked by stale persistence artifacts).
 */
export async function cleanupSessionPersistence(
  sessionId: string,
  opts: {
    mountKind?: SandboxMountKind;
    builtImageTags?: readonly string[];
    removeHostWorkdir?: boolean;
    removeNodeModulesVolume?: boolean;
    nodeModulesVolumeNames?: readonly string[];
  } = {},
): Promise<void> {
  // 1. Host workdir dir.
  const hostDir = resolveHostWorkdirMount(sessionId);
  if (
    opts.removeHostWorkdir !== false &&
    opts.mountKind !== 'external' &&
    hostDir &&
    existsSync(hostDir)
  ) {
    try {
      rmSync(hostDir, { recursive: true, force: true });
    } catch (e) {
      console.warn(
        `[sandbox-manager] remove host workdir ${hostDir} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // 2. Named node_modules volume.
  const volumeNames = opts.nodeModulesVolumeNames
    ? [...new Set(opts.nodeModulesVolumeNames)]
    : opts.removeNodeModulesVolume !== false
      ? [nodeModulesVolumeFor(sessionId)]
      : [];
  if (volumeNames.length > 0) {
    const binary =
      process.env.MCP_SANDBOX_RUNTIME === 'podman' ? 'podman' : 'docker';
    await Promise.all(
      volumeNames.map(
        (volName) =>
          new Promise<void>((resolve) => {
            const child = spawnChild(binary, ['volume', 'rm', '-f', volName], {
              stdio: 'ignore',
            });
            child.once('error', () => resolve());
            child.once('close', () => resolve());
          }),
      ),
    );
  }

  // 3. Custom-built images.
  const tags = [...new Set((opts.builtImageTags ?? []).filter(Boolean))];
  if (tags.length > 0) {
    const driver = await resolveDriver().catch(() => null);
    await Promise.allSettled(
      tags.map((tag) => driver?.removeImage(tag).catch(() => void 0)),
    );
  }
}
