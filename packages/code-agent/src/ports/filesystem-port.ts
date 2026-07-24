/**
 * Filesystem port — abstracts away the concrete filesystem implementation
 * used by coder tools (`write_file`, `read_file`, `edit_file`, `multi_edit`,
 * `create_file`, `list_directory`).
 *
 * Motivation: the default implementation talks directly to the host's
 * filesystem via `node:fs/promises`. When a session runs in "builder" mode
 * we want the exact same tool code to route to an ephemeral container
 * instead, without bifurcating every tool with `if (sandbox) ... else ...`
 * branches — that would violate SRP and multiply the regression surface.
 *
 * Design:
 *   - The port operates on ABSOLUTE paths. Callers are expected to have
 *     already resolved project-relative paths through `resolveSafe()`.
 *     This keeps the port free of cwd / sandbox-root concerns.
 *   - The interface is deliberately narrow (ISP): it only exposes the
 *     operations that existing tools actually need. Adding a method must
 *     be justified by a real tool call-site.
 *   - `LocalFilesystemAdapter` delegates byte-for-byte to `node:fs/promises`
 *     and MUST preserve the exact behavior of the pre-refactor tools.
 */

import { promises as fs } from 'node:fs';
import type { ToolMutationFence } from '@mcp/code-agent/core/tool.js';

/**
 * Minimal directory entry shape needed by tools. Matches the subset of
 * `node:fs.Dirent` used by `list_directory` (name + isDirectory only).
 * Sandbox adapters synthesize these from container directory listings.
 */
export interface PortDirent {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface PortStats {
  isDirectory(): boolean;
  isFile(): boolean;
  size: number;
}

export interface FilesystemReaddirOptions {
  /** Always true in our tools — kept explicit so future additions can't silently regress. */
  withFileTypes: true;
}

export interface IFilesystemPort {
  /**
   * True when this adapter either performs the physical effect synchronously
   * at method entry or cooperatively revalidates an installed mutation fence
   * after any internal await and immediately before dispatching the effect.
   */
  readonly mutationFenceAttested?: true;

  /**
   * Composite ports (for example the snapshot recorder) use this hook to
   * receive the invocation-local fence and reassert it at their real inner
   * effect boundary.
   */
  setMutationFenceSource?(source: () => ToolMutationFence | undefined): void;

  /** Write `data` to `absPath` in utf-8. Overwrites if the file exists. */
  writeFile(absPath: string, data: string): Promise<void>;

  /** Read the whole file at `absPath` as utf-8. Throws if it doesn't exist. */
  readFile(absPath: string): Promise<string>;

  /**
   * Create the directory at `absPath`. When `recursive` is true, creates
   * intermediate directories and does not throw if the target exists.
   */
  mkdir(absPath: string, options?: { recursive?: boolean }): Promise<void>;

  /** Throws when `absPath` does not exist. Resolves otherwise. */
  access(absPath: string): Promise<void>;

  /** Read a directory. Only the `{ withFileTypes: true }` form is exposed. */
  readdir(absPath: string, options: FilesystemReaddirOptions): Promise<PortDirent[]>;

  /** Remove a file at `absPath`. Throws if it does not exist. */
  unlink(absPath: string): Promise<void>;

  /** Return basic metadata for `absPath`. Throws if it does not exist. */
  stat(absPath: string): Promise<PortStats>;

  /** Move or rename a filesystem entry. Destination parent must exist. */
  rename(oldAbsPath: string, newAbsPath: string): Promise<void>;

  /** Remove a file or directory. Mirrors the subset of node fs.rm we need. */
  rm(absPath: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
}

/**
 * Default implementation: thin, direct delegation to `node:fs/promises`.
 * Holds no per-session state — safe to share as a process-wide singleton.
 */
export class LocalFilesystemAdapter implements IFilesystemPort {
  readonly mutationFenceAttested = true as const;

  async writeFile(absPath: string, data: string): Promise<void> {
    await fs.writeFile(absPath, data, 'utf-8');
  }

  async readFile(absPath: string): Promise<string> {
    return await fs.readFile(absPath, 'utf-8');
  }

  async mkdir(absPath: string, options?: { recursive?: boolean }): Promise<void> {
    await fs.mkdir(absPath, options);
  }

  async access(absPath: string): Promise<void> {
    await fs.access(absPath);
  }

  async readdir(absPath: string, _options: FilesystemReaddirOptions): Promise<PortDirent[]> {
    const entries = await fs.readdir(absPath, { withFileTypes: true });
    // Dirent from node:fs already satisfies PortDirent structurally.
    return entries;
  }

  async unlink(absPath: string): Promise<void> {
    await fs.unlink(absPath);
  }

  async stat(absPath: string): Promise<PortStats> {
    return await fs.stat(absPath);
  }

  async rename(oldAbsPath: string, newAbsPath: string): Promise<void> {
    await fs.rename(oldAbsPath, newAbsPath);
  }

  async rm(absPath: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    await fs.rm(absPath, options);
  }
}

// Process-wide singleton. Tools fall back to this when `ctx.ports?.fs` is
// undefined (i.e. tests constructing a minimal ToolContext). This preserves
// byte-for-byte the pre-refactor behavior without forcing every call site
// to pass the default.
let defaultFs: IFilesystemPort | null = null;
export function defaultLocalFilesystemPort(): IFilesystemPort {
  if (!defaultFs) defaultFs = new LocalFilesystemAdapter();
  return defaultFs;
}
