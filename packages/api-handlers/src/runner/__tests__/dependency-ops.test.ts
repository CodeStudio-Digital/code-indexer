import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: execFileMock }));

import { addDependency } from '../dependency-ops.js';

const roots: string[] = [];
const emptyEnv = { pathPrepend: [], extraEnv: {}, posixPathPrepend: [], posixExtraEnv: {} };

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'mcp-nuget-add-'));
  roots.push(root);
  return root;
}

beforeEach(() => {
  execFileMock.mockReset();
  execFileMock.mockImplementation((_file, _args, _opts, callback) => {
    callback(null, '', '');
    return { pid: 1 };
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('NuGet dependency operation', () => {
  it('runs dotnet add against the unique exact project', async () => {
    const root = fixture();
    mkdirSync(join(root, 'src', 'App'), { recursive: true });
    const project = join(root, 'src', 'App', 'App.csproj');
    writeFileSync(project, '<Project/>');

    await expect(addDependency({
      root,
      manager: 'dotnet',
      packageId: 'Newtonsoft.Json',
      version: '13.0.3',
      target: { kind: 'host' },
      env: emptyEnv,
    })).resolves.toEqual({ changed: true, manifest: 'src/App/App.csproj' });

    expect(execFileMock).toHaveBeenCalledWith(
      'dotnet',
      ['add', project, 'package', 'Newtonsoft.Json', '--version', '13.0.3'],
      expect.objectContaining({ cwd: root, timeout: 120_000 }),
      expect.any(Function),
    );
  });

  it('does not guess between multiple projects', async () => {
    const root = fixture();
    for (const name of ['One', 'Two']) {
      mkdirSync(join(root, 'src', name), { recursive: true });
      writeFileSync(join(root, 'src', name, `${name}.csproj`), '<Project/>');
    }

    await expect(addDependency({
      root,
      manager: 'dotnet',
      packageId: 'Newtonsoft.Json',
      version: '13.0.3',
      target: { kind: 'host' },
      env: emptyEnv,
    })).rejects.toThrow(/multiple \.csproj/);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('rejects an explicit project outside the repository', async () => {
    const root = fixture();
    await expect(addDependency({
      root,
      manager: 'dotnet',
      packageId: 'Newtonsoft.Json',
      version: '13.0.3',
      projectFile: '../escape.csproj',
      target: { kind: 'host' },
      env: emptyEnv,
    })).rejects.toThrow(/escapes the project root/);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
