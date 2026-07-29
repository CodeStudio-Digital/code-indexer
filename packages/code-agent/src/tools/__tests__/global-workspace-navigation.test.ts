import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newSessionId } from '@mcp/session-storage';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { fsTools } from '../fs.js';
import { globTool } from '../glob.js';
import { gitTools, gitToolsForProject } from '../git.js';
import { shellTools } from '../shell.js';
import { applyParsedPatch, parseApplyPatch } from '../apply-patch.js';
import { SessionOverlay } from '../../overlay/session-overlay.js';
import { SnapshotRecorder } from '../../ports/snapshot-recording-filesystem-port.js';
import { defaultLocalFilesystemPort } from '../../ports/filesystem-port.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): ToolContext {
  const base = mkdtempSync(join(tmpdir(), 'coder-global-navigation-'));
  roots.push(base);
  const backend = join(base, 'backend');
  const intranet = join(base, 'intranet');
  mkdirSync(join(backend, 'src'), { recursive: true });
  mkdirSync(join(intranet, 'src'), { recursive: true });
  writeFileSync(join(backend, 'src', 'api.ts'), 'export const api = true;');
  writeFileSync(join(intranet, 'src', 'screen.ts'), 'export const screen = true;');
  const primaryOverlay = new SessionOverlay(backend);
  const secondaryOverlay = new SessionOverlay(intranet);
  return {
    cwd: backend,
    projectName: 'Backend Loyalty',
    projectId: 10,
    overlay: primaryOverlay,
    roots: [{
      projectId: 11,
      name: 'poa-intranet-angular',
      slug: 'poa-intranet-angular',
      rootPath: intranet,
    }],
    overlayByRoot: new Map([[11, secondaryOverlay]]),
    globalWorkspace: {
      sessionTitle: 'Global test',
      primaryRootPath: backend,
      projects: [
        {
          projectId: 10,
          name: 'Backend Loyalty',
          slug: 'backend-loyalty',
          rootPath: backend,
          isPrimary: true,
        },
        {
          projectId: 11,
          name: 'poa-intranet-angular',
          slug: 'poa-intranet-angular',
          rootPath: intranet,
          isPrimary: false,
        },
      ],
    },
  } as ToolContext;
}

describe('native global workspace navigation', () => {
  it('keeps Git tools because cwd is the primary real project', () => {
    expect(gitToolsForProject()).toBe(gitTools);
  });

  it('lists linked projects as directories without changing the tool schema', async () => {
    const list = fsTools.find((tool) => tool.name === 'list_directory')!;
    const result = await list.handler({}, fixture());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('d backend-loyalty');
    expect(result.content).toContain('d poa-intranet-angular');
    expect(list.parameters.properties).not.toHaveProperty('project');
  });

  it('lists a slug-prefixed project directly from its real root', async () => {
    const list = fsTools.find((tool) => tool.name === 'list_directory')!;
    const result = await list.handler(
      { path: 'poa-intranet-angular/src' },
      fixture(),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('f poa-intranet-angular/src/screen.ts');
  });

  it('globs every authorized root and prefixes matches with its slug', async () => {
    const result = await globTool.handler({ pattern: '**/*.ts' }, fixture());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('backend-loyalty/src/api.ts');
    expect(result.content).toContain('poa-intranet-angular/src/screen.ts');
    expect(globTool.parameters.properties).not.toHaveProperty('project');
  });

  it('globs inside an explicitly slug-prefixed subdirectory', async () => {
    const result = await globTool.handler(
      { pattern: '**/*.ts', path: 'poa-intranet-angular/src' },
      fixture(),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('poa-intranet-angular/src/screen.ts');
    expect(result.content).not.toContain('backend-loyalty/src/api.ts');
  });

  it('reports a structured source cap when the glob result limit omits matches', async () => {
    const ctx = fixture();
    const sourceRoot = ctx.globalWorkspace!.projects[0]!.rootPath;
    writeFileSync(join(sourceRoot, 'src', 'second.ts'), 'export const second = true;');
    writeFileSync(join(sourceRoot, 'src', 'third.ts'), 'export const third = true;');

    const result = await globTool.handler({ pattern: '**/*.ts', limit: 1 }, ctx);

    expect(result.content).toContain('1 of 4 matches');
    expect(result.sourceTruncations).toEqual([{
      technique: 'glob-result-limit',
      inputSize: 4,
      outputSize: 1,
      unit: 'items',
      recoverable: true,
    }]);
  });

  it('reads, edits, and marks overlay paths with the project slug', async () => {
    const ctx = fixture();
    const path = 'poa-intranet-angular/src/screen.ts';
    const read = fsTools.find((tool) => tool.name === 'read_file')!;
    const edit = fsTools.find((tool) => tool.name === 'edit_file')!;

    expect((await read.handler(
      { path: 'backend-loyalty/src/api.ts' },
      ctx,
    )).content).toContain('api = true');
    expect((await read.handler({ path }, ctx)).content).toContain('screen = true');
    expect((await edit.handler({ path, old_string: 'true', new_string: 'false' }, ctx)).isError).toBeFalsy();
    expect(readFileSync(join(ctx.globalWorkspace!.projects[0]!.rootPath, 'src', 'api.ts'), 'utf-8'))
      .toContain('api = true');
    const secondary = ctx.globalWorkspace!.projects[1]!;
    expect(readFileSync(join(secondary.rootPath, 'src', 'screen.ts'), 'utf-8'))
      .toContain('screen = false');
    expect(ctx.overlayByRoot?.get(11)?.isDirty('src/screen.ts')).toBe(true);
    expect(ctx.overlay?.isDirty(path)).toBe(false);
  });

  it('routes one-shot shell cwd to the linked real root', async () => {
    const ctx = fixture();
    let seenCwd = '';
    ctx.ports = {
      shell: {
        async exec(_command, options) {
          seenCwd = options.cwd;
          return { stdout: 'ok', stderr: '', exitCode: 0, timedOut: false };
        },
      },
    } as ToolContext['ports'];
    const run = shellTools.find((tool) => tool.name === 'run_command')!;
    const result = await run.handler(
      { command: 'dir', cwd: 'poa-intranet-angular/src' },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(seenCwd).toBe(join(ctx.globalWorkspace!.projects[1]!.rootPath, 'src'));
  });

  it('applies a slug-prefixed patch inside the linked real root', async () => {
    const ctx = fixture();
    const patch = parseApplyPatch(
      '*** Begin Patch\n' +
      '*** Update File: poa-intranet-angular/src/screen.ts\n' +
      '@@\n' +
      '-export const screen = true;\n' +
      '+export const screen = false;\n' +
      '*** End Patch\n',
    );
    const result = await applyParsedPatch(patch, ctx);
    expect(result.updated).toEqual(['poa-intranet-angular/src/screen.ts']);
    expect(readFileSync(
      join(ctx.globalWorkspace!.projects[1]!.rootPath, 'src', 'screen.ts'),
      'utf-8',
    )).toContain('screen = false');
    expect(ctx.overlayByRoot?.get(11)?.isDirty('src/screen.ts')).toBe(true);
  });

  it('records snapshots against the owning project and root-relative path', async () => {
    const ctx = fixture();
    const creates: Array<{ project_id: number | null; file_path: string }> = [];
    const store = {
      async recordBaselineAndEdit(create: { project_id: number | null; file_path: string }) {
        creates.push(create);
        return { baseline: { id: newSessionId() } };
      },
      async recordRoundSnapshotMutation() {
        return { id: newSessionId() };
      },
    };
    const recorder = new SnapshotRecorder({
      sessionKind: 'coder',
      sessionId: newSessionId(),
      projectRoot: ctx.cwd,
      projectId: ctx.projectId,
      secondaryRoots: [{
        projectId: 11,
        rootPath: ctx.globalWorkspace!.projects[1]!.rootPath,
      }],
      store: store as never,
    });

    await recorder.record(
      join(ctx.globalWorkspace!.projects[1]!.rootPath, 'src', 'screen.ts'),
      defaultLocalFilesystemPort(),
      { tool: 'edit_file', expectedAfter: 'changed', isDelete: false },
    );
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({
      project_id: 11,
      file_path: 'src/screen.ts',
    });
  });
});
