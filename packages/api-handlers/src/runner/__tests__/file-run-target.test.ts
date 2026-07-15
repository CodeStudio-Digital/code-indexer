import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DetectedGroup } from '@mcp/api-bus';
import { resolveFileRunTarget } from '../file-run-target.js';

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-file-run-'));
  roots.push(dir);
  return dir;
}
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('resolveFileRunTarget', () => {
  it('runs a Spring Boot Gradle project with its detected wrapper and nested cwd', () => {
    const dir = root();
    mkdirSync(join(dir, 'service'));
    const group: DetectedGroup = {
      manager: 'gradle', source: 'build.gradle', installNeeded: false,
      runners: [{ id: 'gradle:bootRun', label: 'bootRun', manager: 'gradle', command: '.\\gradlew.bat bootRun' }],
    };
    const target = resolveFileRunTarget(
      dir,
      'service/build.gradle',
      "plugins {\n  id 'org.springframework.boot' version '4.0.6'\n}",
      [group],
      'powershell',
    );
    expect(target).toEqual({
      label: 'Run Gradle project',
      manager: 'gradle',
      command: '.\\gradlew.bat bootRun',
      cwd: 'service',
    });
  });

  it('runs a Gradle application project and disables a plain Java library', () => {
    const dir = root();
    writeFileSync(join(dir, 'build.gradle.kts'), '');
    const group: DetectedGroup = {
      manager: 'gradle', source: 'build.gradle.kts', installNeeded: false,
      runners: [{ id: 'gradle:run', label: 'run', manager: 'gradle', command: './gradlew run' }],
    };
    expect(resolveFileRunTarget(dir, 'build.gradle.kts', 'plugins { application }', [group], 'posix').command)
      .toBe('./gradlew run');
    expect(resolveFileRunTarget(dir, 'build.gradle.kts', 'plugins { java }', [group], 'posix').reason)
      .toMatch(/No runnable/);
  });

  it('runs Spring Boot and exec-plugin Maven projects', () => {
    const dir = root();
    writeFileSync(join(dir, 'pom.xml'), '<project/>');
    const group: DetectedGroup = {
      manager: 'maven', source: 'pom.xml', installNeeded: false,
      runners: [
        { id: 'maven:compile', label: 'compile', manager: 'maven', command: './mvnw compile' },
        { id: 'maven:spring-boot:run', label: 'spring-boot:run', manager: 'maven', command: './mvnw spring-boot:run' },
      ],
    };
    expect(resolveFileRunTarget(dir, 'pom.xml', '<artifactId>spring-boot-maven-plugin</artifactId>', [group], 'posix').command)
      .toBe('./mvnw spring-boot:run');
    expect(resolveFileRunTarget(
      dir,
      'pom.xml',
      '<artifactId>exec-maven-plugin</artifactId><mainClass>demo.Main</mainClass>',
      [group],
      'posix',
    ).command).toBe('./mvnw exec:java');
  });

  it('runs an exact executable C# project and disables libraries', () => {
    const dir = root();
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'App.csproj'), '<Project><OutputType>Exe</OutputType></Project>');
    const group: DetectedGroup = {
      manager: 'dotnet', source: 'src/App.csproj', installNeeded: false,
      runners: [{
        id: 'dotnet:run:src/App.csproj',
        label: 'run App',
        manager: 'dotnet',
        command: "dotnet run --project 'src/App.csproj'",
      }],
    };
    expect(resolveFileRunTarget(dir, 'src/App.csproj', '<Project><OutputType>Exe</OutputType></Project>', [group], 'powershell'))
      .toEqual({
        label: 'Run App',
        manager: 'dotnet',
        command: "dotnet run --project 'App.csproj'",
        cwd: 'src',
      });
    expect(resolveFileRunTarget(dir, 'src/App.csproj', '<Project><OutputType>Library</OutputType></Project>', [group], 'powershell').reason)
      .toMatch(/library/);
  });

  it('runs a Maven Java class by its fully-qualified name and wrapper', () => {
    const dir = root();
    mkdirSync(join(dir, 'src'), { recursive: true });
    const group: DetectedGroup = {
      manager: 'maven', source: 'pom.xml', installNeeded: false,
      runners: [{ id: 'maven:compile', label: 'compile', manager: 'maven', command: '.\\mvnw.cmd compile' }],
    };
    const target = resolveFileRunTarget(dir, 'src/App.java', 'package demo.app;\nclass App {}', [group], 'powershell');
    expect(target.command).toBe(".\\mvnw.cmd -Dexec.mainClass='demo.app.App' exec:java");
  });

  it('uses the nearest exact C# project', () => {
    const dir = root();
    mkdirSync(join(dir, 'src', 'App'), { recursive: true });
    writeFileSync(join(dir, 'src', 'App', 'App.csproj'), '<Project/>');
    const target = resolveFileRunTarget(dir, 'src/App/Program.cs', 'Console.WriteLine();', [], 'powershell');
    expect(target).toMatchObject({ command: "dotnet run --project 'App.csproj'", cwd: 'src/App' });
  });

  it('finds a unique project in a conventional nested src directory', () => {
    const dir = root();
    mkdirSync(join(dir, 'src', 'App'), { recursive: true });
    writeFileSync(join(dir, 'src', 'App', 'App.csproj'), '<Project/>');
    mkdirSync(join(dir, 'scratch'), { recursive: true });
    const target = resolveFileRunTarget(dir, 'scratch/Program.cs', 'Console.WriteLine();', [], 'powershell');
    expect(target).toMatchObject({ command: "dotnet run --project 'App.csproj'", cwd: 'src/App' });
  });

  it('uses SDK 10 file mode when no project exists', () => {
    const dir = root();
    expect(resolveFileRunTarget(dir, 'Program.cs', 'Console.WriteLine();', [], 'powershell').command)
      .toBe("dotnet run --file 'Program.cs'");
  });

  it('does not guess among multiple C# projects', () => {
    const dir = root();
    for (const name of ['One', 'Two']) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, `${name}.csproj`), '<Project/>');
    }
    const target = resolveFileRunTarget(dir, 'Shared.cs', 'class Shared {}', []);
    expect(target.command).toBeUndefined();
    expect(target.reason).toMatch(/Multiple .csproj/);
  });

  it('keeps malicious Java file names literal for PowerShell and POSIX run commands', () => {
    const dir = root();
    for (const shellFamily of ['powershell', 'posix'] as const) {
      const target = resolveFileRunTarget(dir, 'Main$(calc).java', 'class Main {}', [], shellFamily);
      expect(target.command).toBe("java 'Main$(calc).java'");
    }
  });

  it('disables a cmd run when the path cannot be represented without expansion', () => {
    const dir = root();
    const target = resolveFileRunTarget(dir, 'Main%PATH%.java', 'class Main {}', [], 'cmd');
    expect(target.command).toBeUndefined();
    expect(target.reason).toMatch(/cannot be represented safely/);
  });

  it('quotes ordinary source-file paths through the selected shell family', () => {
    const dir = root();
    const target = resolveFileRunTarget(dir, 'tools/run$(calc).py', undefined, [], 'powershell');
    expect(target).toMatchObject({ command: "python 'run$(calc).py'", cwd: 'tools' });
  });

  it.each([
    ['php', 'php', 'php'],
    ['py', 'python', 'python'],
    ['js', 'node', 'node'],
    ['mjs', 'node', 'node'],
    ['cjs', 'node', 'node'],
  ] as const)('runs nested .%s files from their own directory', (extension, bin, manager) => {
    const dir = root();
    mkdirSync(join(dir, 'folder with spaces'));
    const target = resolveFileRunTarget(
      dir,
      `folder with spaces/current file.${extension}`,
      undefined,
      [],
      'cmd',
    );
    expect(target).toEqual({
      label: `Run current file.${extension}`,
      manager,
      command: `${bin} "current file.${extension}"`,
      cwd: 'folder with spaces',
    });
  });

  it('keeps a root PHP file relative to the project root', () => {
    const dir = root();
    expect(resolveFileRunTarget(dir, 'teste.php', undefined, [], 'cmd')).toEqual({
      label: 'Run teste.php',
      manager: 'php',
      command: 'php "teste.php"',
      cwd: undefined,
    });
  });

  it('runs a direct nested Java source from its own directory', () => {
    const dir = root();
    mkdirSync(join(dir, 'scratch'));
    expect(resolveFileRunTarget(dir, 'scratch/Main.java', 'class Main {}', [], 'posix')).toEqual({
      label: 'Run Main.java',
      manager: 'java',
      command: "java 'Main.java'",
      cwd: 'scratch',
    });
  });

  it('uses the backend-detected command for a nested manifest script', () => {
    const dir = root();
    mkdirSync(join(dir, 'web'));
    writeFileSync(join(dir, 'web', 'package.json'), '{"scripts":{"dev; calc":"vite"}}');
    const group: DetectedGroup = {
      manager: 'pnpm', source: 'package.json', installNeeded: false,
      runners: [{ id: 'pnpm:dev; calc', label: 'dev; calc', manager: 'pnpm', command: "pnpm run 'dev; calc'" }],
    };
    const target = resolveFileRunTarget(dir, 'web/package.json', undefined, [group], 'powershell', 'dev; calc');
    expect(target).toEqual({
      label: 'Run dev; calc',
      manager: 'pnpm',
      command: "pnpm run 'dev; calc'",
      cwd: 'web',
    });
  });
});
