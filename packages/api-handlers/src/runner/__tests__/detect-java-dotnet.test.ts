import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { invalidateProjectDiscoveryCache } from '@mcp/shared/utils/project-ignore.js';
import { detectRunners, detectRunnersAsync } from '../detect.js';
import {
  clearDotnetProjectScanCache,
  scanDotnetProjects,
  scanDotnetProjectsAsync,
} from '../dotnet-project-files.js';
import { probeManagerStatus } from '../manager-status.js';

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-runner-java-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  clearDotnetProjectScanCache();
  invalidateProjectDiscoveryCache();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Java runner detection', () => {
  it('uses PowerShell-safe Windows wrapper commands', () => {
    const dir = root();
    writeFileSync(join(dir, 'pom.xml'), '<project/>');
    writeFileSync(join(dir, 'mvnw.cmd'), '');
    const group = detectRunners(dir, { shellFamily: 'powershell' }).groups[0];
    expect(group.manager).toBe('maven');
    expect(group.runners[0].command).toBe('.\\mvnw.cmd compile');
    expect(group.installCommand).toBe('.\\mvnw.cmd dependency:resolve');
    expect(group.updateCommand).toBe('.\\mvnw.cmd -U dependency:resolve');
  });

  it('uses POSIX wrappers for WSL and honours the preferred manager', () => {
    const dir = root();
    for (const file of ['pom.xml', 'mvnw', 'build.gradle.kts', 'gradlew']) writeFileSync(join(dir, file), '');
    const groups = detectRunners(dir, { javaManager: 'gradle', shellFamily: 'posix' }).groups;
    expect(groups.map((g) => g.manager)).toEqual(['gradle', 'maven']);
    expect(groups[0].runners[0].command).toBe('./gradlew build');
    expect(groups[0].updateCommand).toContain('--refresh-dependencies');
  });
});

describe('.NET runner detection', () => {
  it('recognizes Unity for C# LSP without scanning generated projects or offering dotnet Play targets', async () => {
    const dir = root();
    mkdirSync(join(dir, 'Assets'));
    mkdirSync(join(dir, 'ProjectSettings'));
    mkdirSync(join(dir, 'Library', 'PackageCache', 'generated'), { recursive: true });
    writeFileSync(join(dir, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.0.0f1');
    writeFileSync(join(dir, 'Assembly-CSharp.csproj'), '<Project/>');
    writeFileSync(join(dir, 'Game.sln'), '');
    writeFileSync(join(dir, 'Library', 'PackageCache', 'generated', 'Generated.csproj'), '<Project/>');

    expect(scanDotnetProjects(dir)).toEqual({ projects: [], solutions: [], unityRoot: true });
    await expect(scanDotnetProjectsAsync(dir)).resolves.toEqual({ projects: [], solutions: [], unityRoot: true });
    const group = detectRunners(dir, { shellFamily: 'powershell' }).groups.find((candidate) => candidate.manager === 'dotnet');
    expect(group).toEqual({
      manager: 'dotnet',
      source: 'ProjectSettings/ProjectVersion.txt',
      installNeeded: false,
      runners: [],
    });
  });

  it('yields during async discovery, shares concurrent work, and invalidates cached manifests', async () => {
    const dir = root();
    for (let index = 0; index < 48; index++) mkdirSync(join(dir, `scope-${index}`));
    mkdirSync(join(dir, 'src', 'App'), { recursive: true });
    writeFileSync(join(dir, 'src', 'App', 'App.csproj'), '<Project/>');

    let eventLoopYielded = false;
    setImmediate(() => { eventLoopYielded = true; });
    const [first, concurrent] = await Promise.all([
      scanDotnetProjectsAsync(dir),
      scanDotnetProjectsAsync(dir),
    ]);
    expect(eventLoopYielded).toBe(true);
    expect(concurrent).toBe(first);
    expect(first.projects).toEqual(['src/App/App.csproj']);

    writeFileSync(join(dir, 'src', 'App', 'Worker.csproj'), '<Project/>');
    expect((await scanDotnetProjectsAsync(dir)).projects).toEqual(['src/App/App.csproj']);
    invalidateProjectDiscoveryCache(dir);
    expect((await scanDotnetProjectsAsync(dir)).projects).toEqual([
      'src/App/App.csproj',
      'src/App/Worker.csproj',
    ]);
    const group = (await detectRunnersAsync(dir, { shellFamily: 'powershell' }))
      .groups.find((candidate) => candidate.manager === 'dotnet');
    expect(group?.runners.some((runner) => runner.command.includes('Worker.csproj'))).toBe(true);
  });

  it('offers restore commands for a project', () => {
    const dir = root();
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'App.csproj'), '<Project/>');
    const group = detectRunners(dir, { shellFamily: 'powershell' }).groups.find((g) => g.manager === 'dotnet');
    expect(group?.installCommand).toBe('dotnet restore');
    expect(group?.updateCommand).toBe('dotnet restore --force');
  });

  it('emits exact run/watch commands for projects nested below src', () => {
    const dir = root();
    mkdirSync(join(dir, 'src', 'App'), { recursive: true });
    writeFileSync(join(dir, 'src', 'App', 'App.csproj'), '<Project/>');
    mkdirSync(join(dir, 'src', 'App', 'obj'), { recursive: true });
    writeFileSync(join(dir, 'src', 'App', 'obj', 'Generated.csproj'), '<Project/>');
    const group = detectRunners(dir, { shellFamily: 'powershell' }).groups.find((candidate) => candidate.manager === 'dotnet');
    expect(group?.runners.map((runner) => runner.command)).toContain("dotnet run --project 'src/App/App.csproj'");
    expect(group?.runners.map((runner) => runner.command)).not.toContain("dotnet run --project 'src/App/obj/Generated.csproj'");
  });

  it('keeps repository-controlled project names literal in PowerShell and POSIX', () => {
    const dir = root();
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'App$(calc).csproj'), '<Project/>');
    for (const shellFamily of ['powershell', 'posix'] as const) {
      const group = detectRunners(dir, { shellFamily }).groups.find((candidate) => candidate.manager === 'dotnet');
      expect(group?.runners.map((runner) => runner.command)).toContain(
        "dotnet run --project 'src/App$(calc).csproj'",
      );
    }
  });

  it('quotes repository-controlled package script names', () => {
    const dir = root();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { 'dev; calc': 'echo safe' } }));
    const group = detectRunners(dir, { shellFamily: 'powershell' }).groups.find((candidate) => candidate.manager === 'npm');
    expect(group?.runners[0].command).toBe("npm run 'dev; calc'");
  });
});

describe('manager status', () => {
  it('accepts a project wrapper without requiring a global Maven install', async () => {
    const dir = root();
    writeFileSync(join(dir, 'mvnw.cmd'), '');
    const status = await probeManagerStatus('maven', {
      pathPrepend: [], extraEnv: {}, posixPathPrepend: [], posixExtraEnv: {},
    }, dir, 'windows');
    expect(status).toEqual({ found: true });
  });
});
