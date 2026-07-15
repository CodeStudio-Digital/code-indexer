import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listDirFiltered } from '../project-files.js';

const roots: string[] = [];

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coder-tree-ignore-'));
  roots.push(dir);
  return dir;
}

function file(base: string, rel: string): void {
  const abs = join(base, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, 'x');
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('coder project tree project-aware ignores', () => {
  it('applies the Unity profile in the legacy tree/search route', async () => {
    const dir = root();
    file(dir, 'ProjectSettings/ProjectVersion.txt');
    file(dir, 'Assets/Scripts/Player.cs');
    file(dir, 'Packages/manifest.json');
    file(dir, 'Library/PackageCache/pkg/file.cs');
    file(dir, 'Assembly-CSharp.csproj');

    const entries = await listDirFiltered(dir, '.');
    expect(entries.map((entry) => entry.name)).toEqual(['Assets', 'Packages', 'ProjectSettings']);
  });

  it('keeps a real .NET project file and removes only its scoped output', async () => {
    const dir = root();
    file(dir, 'services/App/App.csproj');
    file(dir, 'services/App/Program.cs');
    file(dir, 'services/App/bin/Debug/App.dll');
    file(dir, 'services/App/obj/project.assets.json');

    const entries = await listDirFiltered(dir, 'services/App');
    expect(entries.map((entry) => entry.name)).toEqual(['App.csproj', 'Program.cs']);
  });
});
