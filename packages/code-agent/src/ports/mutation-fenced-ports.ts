import { AsyncLocalStorage } from 'node:async_hooks';
import {
  assertMutationFence,
  combinedMutationSignal,
  MutationFenceError,
} from '@mcp/code-agent/core/mutation-fence.js';
import type { ToolMutationFence } from '@mcp/code-agent/core/tool.js';
import type {
  FilesystemReaddirOptions,
  IFilesystemPort,
  PortDirent,
  PortStats,
} from './filesystem-port.js';
import type {
  IShellPort,
  ShellExecOptions,
  ShellExecResult,
  ShellRunOptions,
} from './shell-port.js';

type FenceSource = () => ToolMutationFence | undefined;
const invocationFenceStorage = new AsyncLocalStorage<ToolMutationFence>();

/** Invocation-local fencing stays isolated even when the registry runs tools concurrently. */
export function currentMutationFence(): ToolMutationFence | undefined {
  return invocationFenceStorage.getStore();
}

export function runWithMutationFence<T>(
  fence: ToolMutationFence,
  operation: () => T,
): T {
  return invocationFenceStorage.run(fence, operation);
}

function effectiveFence(source: FenceSource): ToolMutationFence | undefined {
  return currentMutationFence() ?? source();
}

function assertAttested(
  fence: ToolMutationFence | undefined,
  port: { mutationFenceAttested?: true },
  kind: 'filesystem' | 'shell',
): void {
  if (fence?.mode === 'enforce' && port.mutationFenceAttested !== true) {
    throw new MutationFenceError(
      'unsupported_port',
      `${kind} adapter has no attested physical mutation boundary`,
    );
  }
}

class MutationFencedFilesystemPort implements IFilesystemPort {
  constructor(
    readonly inner: IFilesystemPort,
    private readonly fence: FenceSource,
  ) {
    // Install a stable invocation-local source. Never install the captured
    // fallback on a shared composite port: a parent/non-fenced invocation
    // could otherwise inherit the last child's binding after it completed.
    this.inner.setMutationFenceSource?.(() => currentMutationFence());
  }

  get mutationFenceAttested(): true | undefined {
    return this.inner.mutationFenceAttested;
  }

  setMutationFenceSource(_source: FenceSource): void {
    // This wrapper always resolves through AsyncLocalStorage. Rebinding a
    // shared wrapper would couple concurrent invocations, so it is ignored.
  }

  setCurrentTool(name: string): void {
    const target = this.inner as { setCurrentTool?: (toolName: string) => void };
    target.setCurrentTool?.(name);
  }

  async writeFile(absPath: string, data: string): Promise<void> {
    const fence = effectiveFence(this.fence);
    assertAttested(fence, this.inner, 'filesystem');
    assertMutationFence(fence, {
      kind: 'filesystem',
      operation: 'writeFile',
      resource: absPath,
    });
    await this.inner.writeFile(absPath, data);
  }

  readFile(absPath: string): Promise<string> {
    return this.inner.readFile(absPath);
  }

  async mkdir(absPath: string, options?: { recursive?: boolean }): Promise<void> {
    const fence = effectiveFence(this.fence);
    assertAttested(fence, this.inner, 'filesystem');
    assertMutationFence(fence, {
      kind: 'filesystem',
      operation: 'mkdir',
      resource: absPath,
    });
    await this.inner.mkdir(absPath, options);
  }

  access(absPath: string): Promise<void> {
    return this.inner.access(absPath);
  }

  readdir(absPath: string, options: FilesystemReaddirOptions): Promise<PortDirent[]> {
    return this.inner.readdir(absPath, options);
  }

  async unlink(absPath: string): Promise<void> {
    const fence = effectiveFence(this.fence);
    assertAttested(fence, this.inner, 'filesystem');
    assertMutationFence(fence, {
      kind: 'filesystem',
      operation: 'unlink',
      resource: absPath,
    });
    await this.inner.unlink(absPath);
  }

  stat(absPath: string): Promise<PortStats> {
    return this.inner.stat(absPath);
  }

  async rename(oldAbsPath: string, newAbsPath: string): Promise<void> {
    const fence = effectiveFence(this.fence);
    assertAttested(fence, this.inner, 'filesystem');
    assertMutationFence(fence, {
      kind: 'filesystem',
      operation: 'rename',
      resource: oldAbsPath,
    });
    assertMutationFence(fence, {
      kind: 'filesystem',
      operation: 'rename',
      resource: newAbsPath,
    });
    await this.inner.rename(oldAbsPath, newAbsPath);
  }

  async rm(absPath: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    const fence = effectiveFence(this.fence);
    assertAttested(fence, this.inner, 'filesystem');
    assertMutationFence(fence, {
      kind: 'filesystem',
      operation: 'rm',
      resource: absPath,
    });
    await this.inner.rm(absPath, options);
  }
}

class MutationFencedShellPort implements IShellPort {
  constructor(
    readonly inner: IShellPort,
    private readonly fence: FenceSource,
  ) {}

  get mutationFenceAttested(): true | undefined {
    return this.inner.mutationFenceAttested;
  }

  exec(command: string, options: ShellExecOptions): Promise<ShellExecResult> {
    const fence = effectiveFence(this.fence);
    assertAttested(fence, this.inner, 'shell');
    assertMutationFence(fence, {
      kind: 'shell',
      operation: 'exec',
      resource: command,
    });
    return this.inner.exec(command, {
      ...options,
      signal: combinedMutationSignal(options.signal, fence),
    });
  }

  run(
    program: string,
    args: string[],
    options: ShellRunOptions,
  ): Promise<ShellExecResult> {
    const fence = effectiveFence(this.fence);
    assertAttested(fence, this.inner, 'shell');
    assertMutationFence(fence, {
      kind: 'shell',
      operation: 'run',
      resource: program,
    });
    return this.inner.run(program, args, {
      ...options,
      signal: combinedMutationSignal(options.signal, fence),
    });
  }

  spawn(
    program: string,
    args: string[],
    options: ShellExecOptions,
  ): Promise<ShellExecResult> {
    const fence = effectiveFence(this.fence);
    assertAttested(fence, this.inner, 'shell');
    assertMutationFence(fence, {
      kind: 'shell',
      operation: 'spawn',
      resource: program,
    });
    return this.inner.spawn(program, args, {
      ...options,
      signal: combinedMutationSignal(options.signal, fence),
    });
  }
}

export function mutationFencedFilesystemPort(
  inner: IFilesystemPort,
  fence: FenceSource,
): IFilesystemPort {
  const raw = inner instanceof MutationFencedFilesystemPort ? inner.inner : inner;
  return new MutationFencedFilesystemPort(raw, fence);
}

export function mutationFencedShellPort(
  inner: IShellPort,
  fence: FenceSource,
): IShellPort {
  const raw = inner instanceof MutationFencedShellPort ? inner.inner : inner;
  return new MutationFencedShellPort(raw, fence);
}
