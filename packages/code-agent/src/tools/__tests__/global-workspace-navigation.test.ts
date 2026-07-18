import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { fsTools } from '../fs.js';
import { globTool } from '../glob.js';
import { gitTools, gitToolsForProject } from '../git.js';
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
  const intranet = join(base, 'intranet');
  const union = join(base, 'union');
  mkdirSync(union);
  mkdirSync(join(intranet, 'src'), { recursive: true });
  writeFileSync(join(intranet, 'src', 'screen.ts'), 'export const screen = true;');
  symlinkSync(intranet, join(union, 'poa-intranet-angular'), 'junction');
  return {
    cwd: union,
    projectName: '__global_test',
    projectId: 99,
    overlay: new SessionOverlay(union),
    globalWorkspace: {
      syntheticProjectName: '__global_test',
      rootPath: join(base, 'union'),
      projects: [{
        projectId: 11,
        name: 'poa-intranet-angular',
        slug: 'poa-intranet-angular',
        rootPath: intranet,
        isPrimary: true,
      }],
    },
  } as ToolContext;
}

describe('native global workspace navigation', () => {
  it('omits Git tools only for synthetic workspaces', () => {
    expect(gitToolsForProject(true)).toEqual([]);
    expect(gitToolsForProject(false)).toBe(gitTools);
  });

  it('lists linked projects as directories without changing the tool schema', async () => {
    const list = fsTools.find((tool) => tool.name === 'list_directory')!;
    const result = await list.handler({}, fixture());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('d poa-intranet-angular');
    expect(list.parameters.properties).not.toHaveProperty('project');
  });

  it('globs every authorized root and prefixes matches with its slug', async () => {
    const result = await globTool.handler({ pattern: '**/*.ts' }, fixture());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('poa-intranet-angular/src/screen.ts');
    expect(globTool.parameters.properties).not.toHaveProperty('project');
  });

  it('reports a structured source cap when the glob result limit omits matches', async () => {
    const ctx = fixture();
    const sourceRoot = ctx.globalWorkspace!.projects[0]!.rootPath;
    writeFileSync(join(sourceRoot, 'src', 'second.ts'), 'export const second = true;');
    writeFileSync(join(sourceRoot, 'src', 'third.ts'), 'export const third = true;');

    const result = await globTool.handler({ pattern: '**/*.ts', limit: 1 }, ctx);

    expect(result.content).toContain('1 of 3 matches');
    expect(result.sourceTruncations).toEqual([{
      technique: 'glob-result-limit',
      inputSize: 3,
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

    expect((await read.handler({ path }, ctx)).content).toContain('screen = true');
    expect((await edit.handler({ path, old_string: 'true', new_string: 'false' }, ctx)).isError).toBeFalsy();
    expect(readFileSync(join(ctx.globalWorkspace!.projects[0]!.rootPath, 'src', 'screen.ts'), 'utf-8'))
      .toContain('screen = false');
    expect(ctx.overlay?.isDirty(path)).toBe(true);
  });

  it('records snapshots with the slug-prefixed virtual path', async () => {
    const ctx = fixture();
    const creates: Array<{ project_id: number | null; file_path: string }> = [];
    const store = {
      recordBaselineAndEdit(create: { project_id: number | null; file_path: string }) {
        creates.push(create);
        return { baseline: { id: 1 } };
      },
    };
    const recorder = new SnapshotRecorder({
      sessionKind: 'coder',
      sessionId: 1,
      projectRoot: ctx.cwd,
      projectId: ctx.projectId,
      store: store as never,
    });

    await recorder.record(
      join(ctx.cwd, 'poa-intranet-angular', 'src', 'screen.ts'),
      defaultLocalFilesystemPort(),
      { tool: 'edit_file', expectedAfter: 'changed', isDelete: false },
    );
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({
      project_id: 99,
      file_path: 'poa-intranet-angular/src/screen.ts',
    });
  });
});
