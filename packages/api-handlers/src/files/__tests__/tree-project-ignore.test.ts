import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HandlerDeps } from '../../types.js';
import { createFilesHandlers } from '../index.js';

const roots: string[] = [];

function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'files-tree-ignore-'));
  roots.push(root);
  return root;
}

function file(root: string, rel: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, 'x');
}

function handlers(root: string) {
  const deps = {
    db: { getProject: (id: number) => id === 1 ? { id, name: 'test', root_path: root } : null },
    fileLocalHistoryStore: {},
  } as unknown as HandlerDeps;
  return createFilesHandlers(deps);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('files.tree project-aware ignores', () => {
  it('returns a clean Unity root while retaining authoritative inputs', async () => {
    const root = projectRoot();
    file(root, 'ProjectSettings/ProjectVersion.txt');
    file(root, 'Packages/manifest.json');
    file(root, 'Assets/Scripts/Player.cs');
    file(root, 'Library/PackageCache/pkg/file.cs');
    file(root, 'obj/generated.cs');
    file(root, 'Assembly-CSharp.csproj');

    const tree = await handlers(root).tree({ projectId: 1, maxDepth: 1 }, {} as never);
    expect(tree.children?.map((entry) => entry.name)).toEqual([
      'Assets', 'Packages', 'ProjectSettings',
    ]);
  });

  it('hides nested .NET output but retains the project file', async () => {
    const root = projectRoot();
    file(root, 'services/App/App.csproj');
    file(root, 'services/App/Program.cs');
    file(root, 'services/App/bin/Debug/App.dll');
    file(root, 'services/App/obj/project.assets.json');

    const tree = await handlers(root).tree({ projectId: 1, root: 'services/App', maxDepth: 1 }, {} as never);
    expect(tree.children?.map((entry) => entry.name)).toEqual(['App.csproj', 'Program.cs']);
  });
});
