/**
 * Adapter that presents an `IFilesystemPort` to coder tools while
 * actually executing filesystem operations inside an OCI sandbox
 * container through an `ISandboxDriver`.
 *
 * This is the bridge that makes the same tool code work for both local
 * development and builder-mode sessions. Tools don't know they're
 * writing into a container — they call `port.writeFile(absPath, data)`
 * and the adapter forwards to `driver.writeFile(containerId, absPath, data)`.
 *
 * Path handling:
 *   The coder tools already resolve project-relative paths through
 *   `resolveSafe(path, ctx.cwd)`. In builder mode, `ctx.cwd` is set to
 *   the container workdir (`/app`), so the absolute paths tools pass
 *   here are already container-side. No rewriting needed.
 */

import type {
  IFilesystemPort,
  PortDirent,
  FilesystemReaddirOptions,
} from '@mcp/code-agent/ports/filesystem-port.js';
import type { ISandboxDriver } from '../ports/sandbox-driver.js';

export interface SandboxFilesystemAdapterOptions {
  driver: ISandboxDriver;
  containerId: string;
}

export class SandboxFilesystemAdapter implements IFilesystemPort {
  private readonly driver: ISandboxDriver;
  private readonly containerId: string;

  constructor(options: SandboxFilesystemAdapterOptions) {
    this.driver = options.driver;
    this.containerId = options.containerId;
  }

  async writeFile(absPath: string, data: string): Promise<void> {
    // `recursive: true` mirrors the tool layer's implicit assumption that
    // `fs.mkdir(dirname(...), { recursive: true })` was already called.
    // The CLI driver creates parents as needed before `cp` runs.
    await this.driver.writeFile(this.containerId, absPath, data, { recursive: true });
  }

  async readFile(absPath: string): Promise<string> {
    return await this.driver.readFile(this.containerId, absPath);
  }

  async mkdir(absPath: string, options?: { recursive?: boolean }): Promise<void> {
    await this.driver.mkdir(this.containerId, absPath, options);
  }

  async access(absPath: string): Promise<void> {
    await this.driver.access(this.containerId, absPath);
  }

  async readdir(absPath: string, _options: FilesystemReaddirOptions): Promise<PortDirent[]> {
    const entries = await this.driver.readdir(this.containerId, absPath);
    return entries.map(synthesizeDirent);
  }

  async unlink(absPath: string): Promise<void> {
    // No dedicated `unlink` on ISandboxDriver — shell out via `run` with
    // argv (no shell parsing). Mirrors how `mkdir` / `access` are layered
    // on top of `run` in cli-oci-driver. `rm -f` is silent on missing
    // files; we surface absence by re-running `access` only on error.
    const res = await this.driver.run(this.containerId, 'rm', ['-f', absPath], {
      timeoutMs: 10_000,
    });
    if (res.exitCode !== 0) {
      const detail = (res.stderr || res.stdout || '').trim();
      throw new Error(`sandbox unlink failed (${res.exitCode}) at ${absPath}: ${detail}`);
    }
  }
}

function synthesizeDirent(entry: { name: string; kind: 'dir' | 'file' | 'other' }): PortDirent {
  const isDir = entry.kind === 'dir';
  const isFile = entry.kind === 'file';
  return {
    name: entry.name,
    isDirectory: () => isDir,
    isFile: () => isFile,
  };
}
