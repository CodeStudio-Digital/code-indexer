/**
 * Resolve the host directory that backs Verdaccio's `/verdaccio/storage`
 * bind-mount.
 *
 * **Why a bind-mount at all**: the official `verdaccio/verdaccio:5`
 * image declares `/verdaccio/storage` as a `VOLUME`. Without an
 * explicit host bind, the runtime allocates an *anonymous* volume that
 * dies with the container. That means every `doEnable()` cycle
 * (operator restart, podman cleanup, OS reboot) wipes:
 *
 *   - the `htpasswd` file (so any user we created is gone);
 *   - every published `.tgz` tarball + manifest;
 *   - the JWT signing secret derived from on-disk state.
 *
 * The persisted `verdaccio_configs.upstream_token` then refers to a
 * user that no longer exists, and `npm publish` fails with E401
 * "Unable to authenticate, your authentication token seems to be
 * invalid" — exactly what session 73 hit on the second publish attempt.
 *
 * Pinning the storage to a known host directory makes restarts safe
 * and lets the operator inspect/back up the registry contents.
 *
 * Pure: no I/O. Caller is responsible for `mkdir -p` before passing
 * the result to the driver.
 */
import { isAbsolute, join, resolve } from 'node:path';

export interface StorageBindOptions {
  /** Operator override (env var `MCP_VERDACCIO_STORAGE_DIR`). Absolute path. */
  override?: string | null | undefined;
  /** Process working directory; the default base for the data dir. */
  cwd: string;
}

/**
 * Default location: `<cwd>/data/packages`.
 *
 * Sits next to `data/virtual-projects/` and `data/design-system-uploads/`
 * so all session-side state lives under one tree the operator already
 * backs up. The name `packages` reflects what the directory actually
 * holds from the operator's perspective: every `.tgz` ever published
 * by a Design System session, plus the htpasswd that authenticates
 * future publishes against them.
 */
export function resolveStorageBindPath(opts: StorageBindOptions): string {
  const override = opts.override?.trim();
  if (override) {
    if (!isAbsolute(override)) {
      throw new Error(
        `MCP_VERDACCIO_STORAGE_DIR must be an absolute path; got ${JSON.stringify(override)}`,
      );
    }
    return resolve(override);
  }
  return resolve(join(opts.cwd, 'data', 'packages'));
}
