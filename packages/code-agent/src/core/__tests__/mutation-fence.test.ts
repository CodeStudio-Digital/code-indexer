import { dirname, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../registry.js';
import {
  createMutationFenceAuthority,
} from '../mutation-fence.js';
import { ok, type CoderTool, type ToolContext, type ToolMutationFence } from '../tool.js';
import type {
  FilesystemReaddirOptions,
  IFilesystemPort,
  PortDirent,
  PortStats,
} from '../../ports/filesystem-port.js';
import type {
  IShellPort,
  ShellExecOptions,
  ShellExecResult,
  ShellRunOptions,
} from '../../ports/shell-port.js';
import {
  SnapshotRecorder,
  SnapshotRecordingFilesystemPort,
} from '../../ports/snapshot-recording-filesystem-port.js';
import type { SessionSnapshotStorePort } from '@mcp/services/services/session-snapshot-port.js';
import {
  asSessionId,
  type SessionId,
} from '@mcp/session-storage';
import { gitTools } from '../../tools/git.js';
import { managePathTool } from '../../tools/manage-path.js';
import { diagramExportTool } from '../../tools/diagram/query.js';
import {
  __testing as execTesting,
  execCommand,
} from '../../tools/exec-command.js';

function authority(options: {
  root: string;
  mode?: 'shadow' | 'enforce';
  linkedRoot?: string;
  owned?: () => boolean;
  epoch?: () => number;
}) {
  return createMutationFenceAuthority({
    mode: options.mode ?? 'enforce',
    authorizedRoot: options.root,
    filesystemRoots: options.linkedRoot
      ? [{ rootPath: options.linkedRoot, aliases: ['linked'], access: 'write' }]
      : undefined,
    assertLease: () => {
      if (options.owned && !options.owned()) throw new Error('lease lost');
    },
    snapshot: () => ({
      environmentId: 'environment:test',
      environmentVersion: 1,
      workspaceLeaseId: 'workspace-lease:test',
      workspaceLeaseVersion: options.epoch?.() ?? 1,
      workspaceFencingEpoch: options.epoch?.() ?? 1,
      ownerAgentRunId: '11111111-1111-4111-8111-111111111111',
    }),
  });
}

class BarrierFilesystem implements IFilesystemPort {
  readonly mutationFenceAttested = true as const;
  readonly writes: Array<{ path: string; data: string }> = [];
  private fenceSource?: () => ToolMutationFence | undefined;
  private arrivals = 0;
  private releaseBarrier!: () => void;
  private readonly barrier = new Promise<void>((resolveBarrier) => {
    this.releaseBarrier = resolveBarrier;
  });

  setMutationFenceSource(source: () => ToolMutationFence | undefined): void {
    this.fenceSource = source;
  }

  async writeFile(path: string, data: string): Promise<void> {
    this.arrivals += 1;
    if (this.arrivals === 2) this.releaseBarrier();
    await this.barrier;
    this.fenceSource?.()?.assertMutation({
      kind: 'filesystem',
      operation: 'writeFile',
      resource: path,
    });
    this.writes.push({ path, data });
  }

  async readFile(): Promise<string> { throw new Error('not found'); }
  async mkdir(): Promise<void> {}
  async access(): Promise<void> {}
  async readdir(
    _path: string,
    _options: FilesystemReaddirOptions,
  ): Promise<PortDirent[]> { return []; }
  async unlink(): Promise<void> {}
  async stat(): Promise<PortStats> {
    return { isDirectory: () => false, isFile: () => true, size: 0 };
  }
  async rename(): Promise<void> {}
  async rm(): Promise<void> {}
}

class SnapshotInnerFilesystem implements IFilesystemPort {
  readonly mutationFenceAttested = true as const;
  writes = 0;

  async writeFile(_path: string, _data: string): Promise<void> { this.writes += 1; }
  async readFile(_path: string): Promise<string> { return 'before'; }
  async mkdir(_path: string, _options?: { recursive?: boolean }): Promise<void> {}
  async access(_path: string): Promise<void> {}
  async readdir(
    _path: string,
    _options: FilesystemReaddirOptions,
  ): Promise<PortDirent[]> { return []; }
  async unlink(_path: string): Promise<void> {}
  async stat(_path: string): Promise<PortStats> {
    return { isDirectory: () => false, isFile: () => true, size: 6 };
  }
  async rename(_from: string, _to: string): Promise<void> {}
  async rm(_path: string, _options?: { recursive?: boolean; force?: boolean }): Promise<void> {}
}

class RecordingFilesystem extends SnapshotInnerFilesystem {
  readonly mkdirs: string[] = [];
  readonly writtenPaths: string[] = [];

  override async mkdir(path: string, _options?: { recursive?: boolean }): Promise<void> {
    this.mkdirs.push(path);
  }

  override async writeFile(path: string, _data: string): Promise<void> {
    this.writes += 1;
    this.writtenPaths.push(path);
  }
}

class ManageFilesystem implements IFilesystemPort {
  readonly mutationFenceAttested = true as const;
  readonly entries = new Set<string>();
  readonly directories = new Set<string>();
  readonly mkdirs: string[] = [];
  readonly renames: Array<[string, string]> = [];

  async writeFile(path: string): Promise<void> { this.entries.add(path); }
  async readFile(): Promise<string> { return ''; }
  async mkdir(path: string): Promise<void> {
    this.mkdirs.push(path);
    this.directories.add(path);
  }
  async access(path: string): Promise<void> {
    if (!this.entries.has(path) && !this.directories.has(path)) throw new Error('not found');
  }
  async readdir(
    _path: string,
    _options: FilesystemReaddirOptions,
  ): Promise<PortDirent[]> { return []; }
  async unlink(path: string): Promise<void> { this.entries.delete(path); }
  async stat(path: string): Promise<PortStats> {
    if (!this.entries.has(path) && !this.directories.has(path)) throw new Error('not found');
    const directory = this.directories.has(path);
    return { isDirectory: () => directory, isFile: () => !directory, size: 0 };
  }
  async rename(from: string, to: string): Promise<void> {
    this.renames.push([from, to]);
    this.entries.delete(from);
    this.directories.delete(from);
    this.entries.add(to);
  }
  async rm(path: string): Promise<void> {
    this.entries.delete(path);
    this.directories.delete(path);
  }
}

class FakeShell implements IShellPort {
  readonly mutationFenceAttested = true as const;
  readonly runs: Array<{ program: string; args: string[] }> = [];

  async exec(_command: string, _options: ShellExecOptions): Promise<ShellExecResult> {
    return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
  }

  async run(
    program: string,
    args: string[],
    _options: ShellRunOptions,
  ): Promise<ShellExecResult> {
    this.runs.push({ program, args });
    return { stdout: 'M file.ts', stderr: '', exitCode: 0, timedOut: false };
  }

  async spawn(
    _program: string,
    _args: string[],
    _options: ShellExecOptions,
  ): Promise<ShellExecResult> {
    return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
  }
}

const filesystemTool: CoderTool = {
  name: 'fenced_write',
  source: 'native',
  description: 'test',
  mutates: true,
  effectBoundary: 'filesystem',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      project: { type: 'string' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const root = args.project === 'linked'
      ? String((ctx as ToolContext & { linkedRoot?: string }).linkedRoot)
      : ctx.cwd;
    await ctx.ports!.fs!.writeFile(resolve(root, String(args.path)), String(args.path));
    return ok('written');
  },
};

describe('physical mutation fencing', () => {
  it('requires a declared physical boundary even for a logically non-mutating approval tool', async () => {
    let observedBinding:
      | Parameters<ToolMutationFence['bindInvocation']>[0]
      | undefined;
    let boundaryChecks = 0;
    const trackingFence: ToolMutationFence = {
      mode: 'enforce',
      bindInvocation(input) {
        observedBinding = input;
        return this;
      },
      assertMutation() {
        boundaryChecks += 1;
      },
    };
    const registry = new ToolRegistry();
    registry.register({
      name: 'approval_artifact',
      description: 'test',
      source: 'native',
      mutates: false,
      riskLevel: 'read',
      executionClass: 'read',
      effectBoundary: 'control',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => ok('approved'),
    });

    const result = await registry.invoke('approval_artifact', {}, {
      cwd: process.cwd(),
      projectName: 'test',
      mutationFence: trackingFence,
      currentToolUseId: 'approval-artifact',
    });

    expect(result.isError).toBeFalsy();
    expect(observedBinding).toMatchObject({
      boundary: 'control',
      requiresEffectBoundary: true,
    });
    expect(boundaryChecks).toBe(1);
  });

  it('reasserts after snapshot baseline work and performs zero target writes after lease loss', async () => {
    const root = resolve(process.cwd(), 'mutation-fence-snapshot');
    const target = resolve(root, 'file.ts');
    let owned = true;
    let epoch = 1;
    const inner = new SnapshotInnerFilesystem();
    const store = {
      recordBaselineAndEdit: vi.fn(async () => {
        // Deterministic barrier: ownership swaps after the outer port check
        // and baseline capture, but before SnapshotRecordingFilesystemPort
        // dispatches its inner write.
        owned = false;
        epoch = 2;
        return {
          baseline: {
            id: '00000000-0000-4000-8000-000000000001',
          },
          created: true,
        };
      }),
      recordRoundSnapshotMutation: vi.fn(async () => ({
        id: '00000000-0000-4000-8000-000000000002',
      })),
    } as unknown as SessionSnapshotStorePort<SessionId, string>;
    const snapshot = new SnapshotRecordingFilesystemPort(
      inner,
      new SnapshotRecorder({
        sessionKind: 'coder',
        sessionId: asSessionId(
          '00000000-0000-4000-8000-000000000001',
        ),
        projectRoot: root,
        store,
      }),
    );
    const registry = new ToolRegistry();
    registry.register(filesystemTool);

    const result = await registry.invoke('fenced_write', { path: target }, {
      cwd: root,
      projectName: 'test',
      ports: { fs: snapshot },
      mutationFence: authority({
        root,
        owned: () => owned,
        epoch: () => epoch,
      }),
      currentToolUseId: 'snapshot-write',
    });

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain('lease lost');
    expect(inner.writes).toBe(0);
  });

  it('keeps concurrent invocation bindings isolated across primary and linked roots', async () => {
    const root = resolve(process.cwd(), 'mutation-fence-primary');
    const linkedRoot = resolve(process.cwd(), 'mutation-fence-linked');
    const inner = new BarrierFilesystem();
    const registry = new ToolRegistry();
    registry.register(filesystemTool);
    const mutationFence = authority({ root, linkedRoot });
    const base = {
      cwd: root,
      projectName: 'primary',
      linkedRoot,
      roots: [{
        projectId: 2,
        name: 'Linked',
        slug: 'linked',
        rootPath: linkedRoot,
      }],
      ports: { fs: inner },
      mutationFence,
    } as unknown as ToolContext & { linkedRoot: string };

    const [a, b] = await Promise.all([
      registry.invoke('fenced_write', { path: 'a.ts' }, {
        ...base,
        currentToolUseId: 'write-a',
      }),
      registry.invoke('fenced_write', { path: 'b.ts', project: 'linked' }, {
        ...base,
        currentToolUseId: 'write-b',
      }),
    ]);

    expect(a.isError).toBeFalsy();
    expect(b.isError).toBeFalsy();
    expect(inner.writes.map((write) => write.path).sort()).toEqual([
      resolve(linkedRoot, 'b.ts'),
      resolve(root, 'a.ts'),
    ].sort());
  });

  it('binds a slug-prefixed path to the linked real root', () => {
    const root = resolve(process.cwd(), 'mutation-fence-primary');
    const linkedRoot = resolve(process.cwd(), 'mutation-fence-linked');
    const bound = authority({ root, linkedRoot }).bindInvocation({
      toolName: 'write_file',
      toolUseId: 'write-linked-prefix',
      effectiveInput: {
        path: 'linked/src/file.ts',
        content: 'export const linked = true;',
      },
      boundary: 'filesystem',
      requiresEffectBoundary: true,
    });

    expect(() => bound.assertMutation({
      kind: 'filesystem',
      operation: 'writeFile',
      resource: resolve(linkedRoot, 'src', 'file.ts'),
    })).not.toThrow();
  });

  it('allows only the bound target parent mkdir before a file write', async () => {
    const root = resolve(process.cwd(), 'mutation-fence-parent');
    const target = resolve(root, 'nested', 'file.ts');
    const sibling = resolve(root, 'sibling');
    const inner = new RecordingFilesystem();
    const registry = new ToolRegistry();
    registry.register({
      ...filesystemTool,
      name: 'write_with_parent',
      handler: async (args, ctx) => {
        const path = String(args.path);
        await ctx.ports!.fs!.mkdir(dirname(path), { recursive: true });
        await ctx.ports!.fs!.writeFile(path, 'ok');
        return ok('written');
      },
    });
    registry.register({
      ...filesystemTool,
      name: 'mkdir_sibling',
      handler: async (_args, ctx) => {
        await ctx.ports!.fs!.mkdir(sibling, { recursive: true });
        return ok('unexpected');
      },
    });
    const mutationFence = authority({ root });

    const allowed = await registry.invoke('write_with_parent', { path: target }, {
      cwd: root,
      projectName: 'test',
      ports: { fs: inner },
      mutationFence,
      currentToolUseId: 'parent-allowed',
    });
    expect(allowed.isError).toBeFalsy();
    expect(inner.mkdirs).toEqual([dirname(target)]);
    expect(inner.writtenPaths).toEqual([target]);

    const denied = await registry.invoke('mkdir_sibling', { path: target }, {
      cwd: root,
      projectName: 'test',
      ports: { fs: inner },
      mutationFence,
      currentToolUseId: 'sibling-denied',
    });
    expect(denied.isError).toBe(true);
    expect(inner.mkdirs).toEqual([dirname(target)]);
  });

  it('fences manage_path mkdir, move, and derived trash destinations', async () => {
    const root = resolve(process.cwd(), 'mutation-fence-manage');
    const inner = new ManageFilesystem();
    const registry = new ToolRegistry();
    registry.register(managePathTool);
    const mutationFence = authority({ root });

    const mkdirResult = await registry.invoke('manage_path', {
      operation: 'mkdir',
      path: 'created',
    }, {
      cwd: root,
      projectName: 'test',
      ports: { fs: inner },
      mutationFence,
      currentToolUseId: 'manage-mkdir',
    });
    expect(mkdirResult.isError).toBeFalsy();

    const moveSource = resolve(root, 'old.ts');
    inner.entries.add(moveSource);
    const moveResult = await registry.invoke('manage_path', {
      operation: 'move',
      from_path: 'old.ts',
      to_path: 'nested/new.ts',
    }, {
      cwd: root,
      projectName: 'test',
      ports: { fs: inner },
      mutationFence,
      currentToolUseId: 'manage-move',
    });
    expect(moveResult.isError).toBeFalsy();
    expect(inner.renames).toContainEqual([
      moveSource,
      resolve(root, 'nested', 'new.ts'),
    ]);

    const deleteSource = resolve(root, 'delete-me.ts');
    inner.entries.add(deleteSource);
    const deleteResult = await registry.invoke('manage_path', {
      operation: 'delete',
      path: 'delete-me.ts',
    }, {
      cwd: root,
      projectName: 'test',
      ports: { fs: inner },
      mutationFence,
      currentToolUseId: 'manage-delete',
    });
    expect(deleteResult.isError).toBeFalsy();
    const trashRename = inner.renames.find(([from]) => from === deleteSource);
    expect(trashRename?.[1].replace(/\\/g, '/')).toContain('/.mcp-indexer/trash/');
  });

  it('fails closed for an unsupported mutating capability in ENFORCE and preserves SHADOW', async () => {
    let sideEffects = 0;
    const unsupported: CoderTool = {
      name: 'mcp__remote__mutate',
      source: 'mcp_external',
      description: 'test',
      mutates: true,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => {
        sideEffects += 1;
        return ok('mutated');
      },
    };
    const registry = new ToolRegistry();
    registry.register(unsupported);
    const root = resolve(process.cwd(), 'mutation-fence-unsupported');

    const blocked = await registry.invoke(unsupported.name, {}, {
      cwd: root,
      projectName: 'test',
      mutationFence: authority({ root }),
    });
    expect(blocked.isError).toBe(true);
    expect(sideEffects).toBe(0);

    const shadowed = await registry.invoke(unsupported.name, {}, {
      cwd: root,
      projectName: 'test',
      mutationFence: authority({ root, mode: 'shadow' }),
    });
    expect(shadowed.isError).toBeFalsy();
    expect(sideEffects).toBe(1);
  });

  it('fails closed before the renderer-mediated diagram export bridge in ENFORCE', async () => {
    let handlerEntries = 0;
    const registry = new ToolRegistry();
    registry.register({
      ...diagramExportTool,
      handler: async (args, ctx) => {
        handlerEntries += 1;
        return diagramExportTool.handler(args, ctx);
      },
    });
    const root = resolve(process.cwd(), 'mutation-fence-diagram-export');

    expect(diagramExportTool.effectBoundary).toBeUndefined();
    const result = await registry.invoke('diagram_export', {
      name: 'architecture',
      format: 'svg',
    }, {
      cwd: root,
      projectName: 'test',
      mutationFence: authority({ root }),
      currentToolUseId: 'diagram-export',
    });

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain('no declared physical effect boundary');
    expect(handlerEntries).toBe(0);
  });

  it('binds both apply_patch move source and `*** Move to:` destination', () => {
    const root = resolve(process.cwd(), 'mutation-fence-patch');
    const source = resolve(root, 'old.ts');
    const destination = resolve(root, 'new.ts');
    const bound = authority({ root }).bindInvocation({
      toolName: 'apply_patch',
      toolUseId: 'patch-move',
      effectiveInput: {
        patch:
          '*** Begin Patch\n' +
          '*** Update File: old.ts\n' +
          '*** Move to: new.ts\n' +
          '@@\n-old\n+new\n' +
          '*** End Patch\n',
      },
      boundary: 'filesystem',
      requiresEffectBoundary: true,
    });

    expect(() => bound.assertMutation({
      kind: 'filesystem',
      operation: 'rename',
      resource: source,
    })).not.toThrow();
    expect(() => bound.assertMutation({
      kind: 'filesystem',
      operation: 'rename',
      resource: destination,
    })).not.toThrow();
  });

  it('derives bounded filesystem targets for diagram and submit_spec families', () => {
    const root = resolve(process.cwd(), 'mutation-fence-derived');
    const diagram = authority({ root }).bindInvocation({
      toolName: 'diagram_create',
      toolUseId: 'diagram-create',
      effectiveInput: { name: 'Auth Flow.drawio', xml: '<mxfile />' },
      boundary: 'filesystem',
      requiresEffectBoundary: true,
    });
    expect(() => diagram.assertMutation({
      kind: 'filesystem',
      operation: 'mkdir',
      resource: resolve(root, 'diagrams'),
    })).not.toThrow();
    expect(() => diagram.assertMutation({
      kind: 'filesystem',
      operation: 'writeFile',
      resource: resolve(root, 'diagrams', 'auth-flow.drawio'),
    })).not.toThrow();

    const spec = authority({ root }).bindInvocation({
      toolName: 'submit_spec',
      toolUseId: 'submit-spec',
      effectiveInput: { name: 'Durable Agent Run', body: '# spec' },
      boundary: 'filesystem',
      requiresEffectBoundary: true,
    });
    expect(() => spec.assertMutation({
      kind: 'filesystem',
      operation: 'mkdir',
      resource: resolve(root, '.mcp', 'specs'),
    })).not.toThrow();
    expect(() => spec.assertMutation({
      kind: 'filesystem',
      operation: 'writeFile',
      resource: resolve(root, '.mcp', 'specs', 'durable-agent-run-1770000000.md'),
    })).not.toThrow();
  });

  it('fails closed when a project-internal symlink or junction escapes the delegated root', () => {
    const base = mkdtempSync(resolve(tmpdir(), 'mutation-fence-link-'));
    const root = resolve(base, 'project');
    const outside = resolve(base, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    const link = resolve(root, 'link');
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      expect(() => authority({ root }).bindInvocation({
        toolName: 'fenced_write',
        toolUseId: 'symlink-escape',
        effectiveInput: { path: resolve(link, 'escape.ts') },
        boundary: 'filesystem',
        requiresEffectBoundary: true,
      })).toThrow(/symlink|junction/i);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('binds git read commands to the attested shell boundary under ENFORCE', async () => {
    const root = resolve(process.cwd(), 'mutation-fence-git');
    const shell = new FakeShell();
    const registry = new ToolRegistry();
    registry.register(gitTools.find((tool) => tool.name === 'git_status')!);

    const result = await registry.invoke('git_status', {}, {
      cwd: root,
      projectName: 'test',
      ports: { shell },
      mutationFence: authority({ root }),
      currentToolUseId: 'git-status',
    });

    expect(result.isError).toBeFalsy();
    expect(shell.runs).toEqual([{
      program: 'git',
      args: ['status', '--short'],
    }]);
  });

  it('derives exec_command shell binding from cmd and reaches the fenced spawn boundary', async () => {
    const root = process.cwd();
    const registry = new ToolRegistry();
    registry.register(execCommand);
    try {
      const result = await registry.invoke('exec_command', {
        cmd: 'echo mutation-fence-exec-ok',
        yield_time_ms: 5_000,
      }, {
        cwd: root,
        projectName: 'test',
        mutationFence: authority({ root }),
        currentToolUseId: 'exec-command',
      });

      expect(result.isError).toBeFalsy();
      expect(String(result.content)).toContain('mutation-fence-exec-ok');
    } finally {
      execTesting.disposeAll();
    }
  });
});
