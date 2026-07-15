import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearProjectIgnoreRulesCache,
  getProjectIgnoreRules,
  projectGlobPrunePatterns,
  projectIgnorePatterns,
  shouldIgnoreProjectPath,
} from '../project-ignore.js';

const roots: string[] = [];

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'project-ignore-'));
  roots.push(dir);
  return dir;
}

function file(base: string, rel: string, content = ''): void {
  const abs = join(base, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

afterEach(() => {
  clearProjectIgnoreRulesCache();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('project-aware ignore profiles', () => {
  it('covers Maven, Gradle, Android and Eclipse output while preserving build inputs', () => {
    const dir = root();
    file(dir, 'pom.xml', '<project/>');
    const rules = getProjectIgnoreRules(dir);

    expect(rules.scopes).toContainEqual({ path: '', kind: 'java' });
    for (const path of [
      'target/classes/App.class', 'build/classes/App.class', '.gradle/cache.bin',
      'out/production/App.class', 'bin/App.class', '.cxx/debug/cache',
      '.externalNativeBuild/cmake/cache', '.settings/org.eclipse.core.resources.prefs',
      'app.iml', 'hs_err_pid123.log',
    ]) expect(shouldIgnoreProjectPath(rules, path)).toBe(true);

    for (const path of [
      'pom.xml', 'build.gradle.kts', 'gradlew', '.mvn/wrapper/maven-wrapper.properties',
      'src/main/java/App.java', 'src/main/resources/application.yml',
    ]) expect(shouldIgnoreProjectPath(rules, path)).toBe(false);
  });

  it('scopes nested .NET output without hiding a monorepo root bin directory', () => {
    const dir = root();
    file(dir, 'bin/dev-tool.ps1', 'echo ok');
    file(dir, 'services/App/App.csproj', '<Project/>');
    const rules = getProjectIgnoreRules(dir);

    expect(rules.scopes).toContainEqual({ path: 'services/App', kind: 'dotnet' });
    expect(shouldIgnoreProjectPath(rules, 'bin/dev-tool.ps1')).toBe(false);
    for (const path of [
      'services/App/bin/Debug/net9.0/App.dll',
      'services/App/obj/project.assets.json',
      'services/App/TestResults/result.trx',
      'services/App/artifacts/publish/App.dll',
      'services/App/App.csproj.user',
      'services/App/results.coverage',
    ]) expect(shouldIgnoreProjectPath(rules, path)).toBe(true);
    expect(shouldIgnoreProjectPath(rules, 'services/App/App.csproj')).toBe(false);
    expect(shouldIgnoreProjectPath(rules, 'services/App/Directory.Build.props')).toBe(false);

    const patterns = projectGlobPrunePatterns(rules);
    expect(patterns).toContain('services/App/**/bin/**');
  });

  it('recognizes Unity strictly and removes only generated/cache artifacts', () => {
    const dir = root();
    mkdirSync(join(dir, 'Assets'), { recursive: true });
    mkdirSync(join(dir, 'Packages'), { recursive: true });
    file(dir, 'ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 6000.0');
    const rules = getProjectIgnoreRules(dir);

    expect(rules.scopes).toEqual([{ path: '', kind: 'unity' }]);
    for (const path of [
      'Library/PackageCache/pkg/file.cs', 'Temp/cache', 'Logs/Editor.log',
      'UserSettings/EditorUserSettings.asset', 'obj/Debug/generated.cs',
      'Assembly-CSharp.csproj', 'Game.sln', 'Assets/Player.prefab.meta',
    ]) expect(shouldIgnoreProjectPath(rules, path)).toBe(true);

    for (const path of [
      'Assets/Scripts/Player.cs', 'Assets/Player.prefab', 'Assets/Main.unity',
      'Packages/manifest.json', 'ProjectSettings/TagManager.asset',
    ]) expect(shouldIgnoreProjectPath(rules, path)).toBe(false);

    expect(projectIgnorePatterns(rules)).toContain('*.meta');
    expect(projectGlobPrunePatterns(rules)).toContain('**/Library/**');
    expect(projectGlobPrunePatterns(rules)).toContain('**/*.meta');
  });

  it('does not hide an ordinary Library folder without the Unity marker', () => {
    const dir = root();
    file(dir, 'Library/domain/catalog.ts', 'export {}');
    const rules = getProjectIgnoreRules(dir);
    expect(rules.scopes).toEqual([]);
    expect(shouldIgnoreProjectPath(rules, 'Library/domain/catalog.ts')).toBe(false);
  });
});
