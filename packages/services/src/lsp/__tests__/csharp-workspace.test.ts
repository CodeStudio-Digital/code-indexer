import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveCsharpWorkspace } from '../csharp-workspace.js';

const roots: string[] = [];
function temp(): string {
  const root = mkdtempSync(join(tmpdir(), 'mcp-csharp-workspace-'));
  roots.push(root);
  return root;
}
function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('resolveCsharpWorkspace', () => {
  it('uses a real solution directly and generates nothing', () => {
    const root = temp();
    const data = temp();
    write(join(root, 'Real.sln'), 'Microsoft Visual Studio Solution File');
    const workspace = resolveCsharpWorkspace({ sourceRoot: root, baseDir: data, projectId: 1, serverVersion: '1.39.15' });
    expect(workspace.mode).toBe('project');
    expect(workspace.launchTarget).toBe(join(root, 'Real.sln'));
    expect(existsSync(join(data, '.workspaces'))).toBe(false);
  });

  it('creates a basic netstandard2.1 workspace only under the data directory', () => {
    const root = temp();
    const data = temp();
    write(join(root, 'Local.cs'), 'class Local {}');
    const workspace = resolveCsharpWorkspace({ sourceRoot: root, baseDir: data, projectId: 2, serverVersion: '1.39.15' });
    expect(workspace.mode).toBe('generated-basic');
    expect(workspace.launchTarget.startsWith(data)).toBe(true);
    expect(readFileSync(workspace.launchTarget, 'utf8')).toContain('<TargetFrameworkIdentifier>.NETStandard</TargetFrameworkIdentifier>');
    expect(readFileSync(workspace.launchTarget, 'utf8')).toContain('<TargetFrameworkVersion>v2.1</TargetFrameworkVersion>');
    expect(readFileSync(workspace.launchTarget, 'utf8')).toContain(join(root, '**', '*.cs'));
    expect(existsSync(join(root, 'CodeStudio.Generated.csproj'))).toBe(false);
  });

  it('reuses defines, Unity editor version and references from a registered host', () => {
    const packageRoot = temp();
    const hostRoot = temp();
    const data = temp();
    write(join(packageRoot, 'package.json'), JSON.stringify({ name: 'com.example.scene' }));
    write(join(packageRoot, 'Runtime', 'Example.Scene.asmdef'), JSON.stringify({ name: 'Example.Scene' }));
    write(join(packageRoot, 'Runtime', 'Thing.cs'), 'using UnityEngine; class Thing {}');
    write(join(hostRoot, 'Packages', 'manifest.json'), JSON.stringify({ dependencies: { 'com.example.scene': 'file:../scene' } }));
    write(join(hostRoot, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.0.1f1\n');
    write(join(hostRoot, 'Example.Scene.csproj'), `<Project><PropertyGroup>
      <TargetFramework>netstandard2.1</TargetFramework><LangVersion>9.0</LangVersion>
      <DefineConstants>UNITY_EDITOR;UNITY_6000_0</DefineConstants></PropertyGroup>
      <ItemGroup><Reference Include="UnityEngine"><HintPath>Library/ScriptAssemblies/UnityEngine.dll</HintPath></Reference></ItemGroup></Project>`);

    const workspace = resolveCsharpWorkspace({
      sourceRoot: packageRoot,
      baseDir: data,
      projectId: 3,
      serverVersion: '1.39.15',
      registeredProjectRoots: [hostRoot],
    });
    const project = readFileSync(workspace.launchTarget, 'utf8');
    expect(workspace.mode).toBe('generated-unity');
    expect(project).toContain('UNITY_EDITOR;UNITY_6000_0');
    expect(project).toContain('<UnityEditorVersion>6000.0.1f1</UnityEditorVersion>');
    expect(project).toContain('UnityEngine.dll');
    expect(workspace.launchTarget.startsWith(data)).toBe(true);
    expect(existsSync(join(packageRoot, 'CodeStudio.Generated.csproj'))).toBe(false);
  });
});
