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
  PortStats,
  FilesystemReaddirOptions,
} from '@mcp/code-agent/ports/filesystem-port.js';
import {
  assertMutationFence,
} from '@mcp/code-agent/core/mutation-fence.js';
import type { ToolMutationFence } from '@mcp/code-agent/core/tool.js';
import type { ISandboxDriver } from '../ports/sandbox-driver.js';

export interface SandboxFilesystemAdapterOptions {
  driver: ISandboxDriver;
  containerId: string;
}

export class SandboxFilesystemAdapter implements IFilesystemPort {
  private readonly driver: ISandboxDriver;
  private readonly containerId: string;
  private mutationFenceSource?: () => ToolMutationFence | undefined;

  constructor(options: SandboxFilesystemAdapterOptions) {
    this.driver = options.driver;
    this.containerId = options.containerId;
  }

  setMutationFenceSource(source: () => ToolMutationFence | undefined): void {
    this.mutationFenceSource = source;
  }

  async writeFile(absPath: string, data: string): Promise<void> {
    // `recursive: true` mirrors the tool layer's implicit assumption that
    // `fs.mkdir(dirname(...), { recursive: true })` was already called.
    // The CLI driver creates parents as needed before `cp` runs.
    assertMutationFence(this.mutationFenceSource?.(), {
      kind: 'filesystem',
      operation: 'writeFile',
      resource: absPath,
    });
    await this.driver.writeFile(this.containerId, absPath, data, { recursive: true });
  }

  async readFile(absPath: string): Promise<string> {
    return await this.driver.readFile(this.containerId, absPath);
  }

  async mkdir(absPath: string, options?: { recursive?: boolean }): Promise<void> {
    assertMutationFence(this.mutationFenceSource?.(), {
      kind: 'filesystem',
      operation: 'mkdir',
      resource: absPath,
    });
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
    assertMutationFence(this.mutationFenceSource?.(), {
      kind: 'filesystem',
      operation: 'unlink',
      resource: absPath,
    });
    const res = await this.driver.run(this.containerId, 'rm', ['-f', absPath], {
      timeoutMs: 10_000,
    });
    if (res.exitCode !== 0) {
      const detail = (res.stderr || res.stdout || '').trim();
      throw new Error(`sandbox unlink failed (${res.exitCode}) at ${absPath}: ${detail}`);
    }
  }

  async stat(absPath: string): Promise<PortStats> {
    const script = [
      'if [ -d "$1" ]; then echo "dir 0";',
      'elif [ -f "$1" ]; then bytes=$(wc -c < "$1" 2>/dev/null || echo 0); echo "file $bytes";',
      'elif [ -e "$1" ]; then echo "other 0";',
      'else exit 2; fi',
    ].join(' ');
    const res = await this.driver.run(this.containerId, 'sh', ['-c', script, 'sh', absPath], {
      timeoutMs: 10_000,
    });
    if (res.exitCode !== 0) {
      const detail = (res.stderr || res.stdout || '').trim();
      throw new Error(`sandbox stat failed (${res.exitCode}) at ${absPath}: ${detail}`);
    }
    const [kind, sizeRaw] = res.stdout.trim().split(/\s+/, 2);
    const size = Number(sizeRaw) || 0;
    return {
      isDirectory: () => kind === 'dir',
      isFile: () => kind === 'file',
      size,
    };
  }

  async rename(oldAbsPath: string, newAbsPath: string): Promise<void> {
    assertMutationFence(this.mutationFenceSource?.(), {
      kind: 'filesystem',
      operation: 'rename',
      resource: oldAbsPath,
    });
    assertMutationFence(this.mutationFenceSource?.(), {
      kind: 'filesystem',
      operation: 'rename',
      resource: newAbsPath,
    });
    const res = await this.driver.run(this.containerId, 'mv', [oldAbsPath, newAbsPath], {
      timeoutMs: 30_000,
    });
    if (res.exitCode !== 0) {
      const detail = (res.stderr || res.stdout || '').trim();
      throw new Error(`sandbox rename failed (${res.exitCode}) from ${oldAbsPath} to ${newAbsPath}: ${detail}`);
    }
  }

  async rm(absPath: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    const st = await this.stat(absPath).catch(() => null);
    const program = st?.isDirectory() && !options?.recursive ? 'rmdir' : 'rm';
    const args: string[] = [];
    if (program === 'rm' && options?.recursive) args.push('-r');
    if (program === 'rm' && options?.force) args.push('-f');
    args.push(absPath);
    assertMutationFence(this.mutationFenceSource?.(), {
      kind: 'filesystem',
      operation: 'rm',
      resource: absPath,
    });
    const res = await this.driver.run(this.containerId, program, args, { timeoutMs: 30_000 });
    if (res.exitCode !== 0) {
      const detail = (res.stderr || res.stdout || '').trim();
      throw new Error(`sandbox rm failed (${res.exitCode}) at ${absPath}: ${detail}`);
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
