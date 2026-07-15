/**
 * Pure path helpers for MCP-managed runtimes installed INSIDE a WSL distro.
 *
 * Managed Linux runtimes live under `$HOME/.mcp/runtimes/<kind>/<version>/` in
 * the distro's own filesystem (no apt/sudo, native ext4). The bin dir is
 * deterministic — `…/<version>/bin` — because the installers extract with
 * `--strip-components=1`, so the resolver builds it WITHOUT probing the distro.
 * `$HOME` is kept literal so bash expands it at spawn (works inside the double
 * quotes of `export PATH="…"`).
 *
 * No fs / child_process here — keep it trivially unit-testable.
 */

import type { RuntimeKind } from '@mcp/api-bus';
import { assertRuntimeVersion, managedVersionFromId } from './runtime-version.js';

/** Distro-side managed root (literal `$HOME`, expanded by bash). */
export const WSL_MANAGED_ROOT = '$HOME/.mcp/runtimes';

/** `$HOME/.mcp/runtimes/<kind>/<version>` — install destination + uninstall target. */
export function wslManagedDir(kind: RuntimeKind, version: string): string {
  return `${WSL_MANAGED_ROOT}/${kind}/${assertRuntimeVersion(version)}`;
}

/**
 * Dir prepended to the distro PATH. Stripped tarballs (node/python/java) put
 * binaries under `<version>/bin`; the .NET SDK archive is FLAT (dotnet at the
 * root), so its version dir IS the bin dir.
 */
export function wslManagedBinDir(kind: RuntimeKind, version: string): string {
  const dir = wslManagedDir(kind, version);
  return kind === 'dotnet' ? dir : `${dir}/bin`;
}

/**
 * Managed install dir for a stored selection id (`managed:<version>`), or null
 * for the system default / an unrecognised id. This is the value JAVA_HOME /
 * DOTNET_ROOT point at inside the distro.
 */
export function wslManagedDirForId(kind: RuntimeKind, id: string | null | undefined): string | null {
  const version = managedVersionFromId(id);
  return version ? wslManagedDir(kind, version) : null;
}

/**
 * Bin dir for a stored selection id (`managed:<version>`), or null for the
 * system default / an unrecognised id (no PATH injection — the distro's own
 * toolchain is used).
 */
export function wslBinDirForId(kind: RuntimeKind, id: string | null | undefined): string | null {
  const version = managedVersionFromId(id);
  return version ? wslManagedBinDir(kind, version) : null;
}

/**
 * Translate a Windows path (`C:\Users\…`) into the WSL mount path
 * (`/mnt/c/Users/…`) so a distro command can read a file the Windows side
 * wrote (e.g. a downloaded archive in the temp dir). Non-Windows-absolute
 * input is returned with separators normalised.
 */
export function toWslMntPath(winPath: string): string {
  const fwd = winPath.replace(/\\/g, '/');
  return fwd.replace(/^([A-Za-z]):\//, (_m, d: string) => `/mnt/${d.toLowerCase()}/`);
}
