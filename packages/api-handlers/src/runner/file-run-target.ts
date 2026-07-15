import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { ApiError, type DetectedGroup, type FileRunTarget } from '@mcp/api-bus';
import { csprojFilesInDir, scanDotnetProjects } from './dotnet-project-files.js';
import { quoteShellArgument, type ShellFamily } from '../terminal/shell-quote.js';

function confined(root: string, file: string): string {
  const absolute = resolve(root, file);
  const rel = relative(root, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new ApiError('invalid_input', 400, 'file escapes the project root');
  return absolute;
}

function rel(root: string, file: string): string {
  return relative(root, file).replace(/\\/g, '/');
}

/** Run a source file from its own directory, as editor users expect. */
function localSourceCommand(
  root: string,
  absolute: string,
  bin: string,
  manager: FileRunTarget['manager'],
  label: string,
  shellFamily: ShellFamily,
  beforeFile: string[] = [],
): FileRunTarget {
  const cwd = rel(root, dirname(absolute));
  const file = quoteShellArgument(basename(absolute), shellFamily);
  return {
    label,
    manager,
    command: [bin, ...beforeFile, file].join(' '),
    cwd: cwd || undefined,
  };
}

function allProjects(root: string): string[] {
  return scanDotnetProjects(root).projects.map((file) => join(root, ...file.split('/')));
}

function csharpProject(root: string, source: string): { project?: string; reason?: string } {
  let cursor = dirname(source);
  while (true) {
    const candidates = csprojFilesInDir(cursor);
    if (candidates.length === 1) return { project: candidates[0] };
    if (candidates.length > 1) return { reason: 'Multiple .csproj files match this source file' };
    if (cursor === root) break;
    const parent = dirname(cursor);
    if (parent === cursor || !relative(root, parent) || relative(root, parent).startsWith('..')) break;
    cursor = parent;
  }
  const candidates = allProjects(root);
  if (candidates.length === 1) return { project: candidates[0] };
  if (candidates.length > 1) return { reason: 'Multiple .csproj files found; open a source beneath the intended project' };
  return {};
}

function projectCwd(root: string, manifest: string): string | undefined {
  const cwd = rel(root, dirname(manifest));
  return cwd || undefined;
}

function runnerByLabel(group: DetectedGroup | undefined, label: string) {
  return group?.runners.find((runner) => runner.label === label);
}

function resolveProjectManifestTarget(
  root: string,
  absolute: string,
  base: string,
  source: string,
  groups: DetectedGroup[],
  shellFamily: ShellFamily,
): FileRunTarget | null {
  if (base === 'pom.xml') {
    const group = groups.find((candidate) => candidate.manager === 'maven' && candidate.source === 'pom.xml');
    const springBoot = /<artifactId>\s*spring-boot-maven-plugin\s*<\/artifactId>/i.test(source);
    const execJava = /<artifactId>\s*exec-maven-plugin\s*<\/artifactId>/i.test(source)
      && /<mainClass>\s*[^<]+\s*<\/mainClass>/i.test(source);
    const runner = springBoot ? runnerByLabel(group, 'spring-boot:run') : undefined;
    if (runner) return { label: 'Run Maven project', manager: 'maven', command: runner.command, cwd: projectCwd(root, absolute) };
    if (execJava && group) {
      const bin = runnerByLabel(group, 'compile')?.command.replace(/\s+compile$/, '') ?? 'mvn';
      return { label: 'Run Maven project', manager: 'maven', command: `${bin} exec:java`, cwd: projectCwd(root, absolute) };
    }
    return {
      label: 'Run Maven project',
      manager: 'maven',
      reason: group ? 'No runnable Spring Boot or exec-maven-plugin application is configured' : 'Maven project was not detected from this pom.xml',
    };
  }

  if (base === 'build.gradle' || base === 'build.gradle.kts') {
    const group = groups.find((candidate) => candidate.manager === 'gradle' && candidate.source === base);
    const springBoot = /(?:id\s*(?:\(\s*)?['"]org\.springframework\.boot['"]|apply\s+plugin\s*:\s*['"]org\.springframework\.boot['"])/i.test(source);
    const application = /(?:id\s*(?:\(\s*)?['"]application['"]|apply\s+plugin\s*:\s*['"]application['"])/i.test(source)
      || /plugins\s*\{[\s\S]*?\bapplication\b[\s\S]*?\}/m.test(source);
    const label = springBoot ? 'bootRun' : application ? 'run' : '';
    const runner = label ? runnerByLabel(group, label) : undefined;
    return runner
      ? { label: 'Run Gradle project', manager: 'gradle', command: runner.command, cwd: projectCwd(root, absolute) }
      : {
          label: 'Run Gradle project',
          manager: 'gradle',
          reason: group ? 'No runnable Spring Boot or application plugin is configured' : `Gradle project was not detected from this ${base}`,
        };
  }

  if (base.endsWith('.csproj')) {
    const projectName = basename(absolute).replace(/\.csproj$/i, '');
    const outputType = /<OutputType>\s*([^<]+?)\s*<\/OutputType>/i.exec(source)?.[1].toLowerCase();
    const runnableSdk = /<Project\b[^>]*\bSdk\s*=\s*['"][^'"]*Microsoft\.NET\.Sdk\.(?:Web|Worker)[^'"]*['"]/i.test(source)
      || /<Sdk\b[^>]*\bName\s*=\s*['"]Microsoft\.NET\.Sdk\.(?:Web|Worker)['"]/i.test(source);
    const runnable = outputType === 'exe' || outputType === 'winexe' || runnableSdk;
    if (!runnable) {
      return {
        label: `Run ${projectName}`,
        manager: 'dotnet',
        reason: outputType === 'library'
          ? 'This .csproj builds a library and has no runnable entry point'
          : 'This .csproj does not declare an executable, Web, or Worker output',
      };
    }
    try {
      return localSourceCommand(
        root,
        absolute,
        'dotnet',
        'dotnet',
        `Run ${projectName}`,
        shellFamily,
        ['run', '--project'],
      );
    } catch (error) {
      return {
        label: `Run ${projectName}`,
        manager: 'dotnet',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return null;
}

export function resolveFileRunTarget(
  root: string,
  file: string,
  content: string | undefined,
  groups: DetectedGroup[],
  shellFamily: ShellFamily = process.platform === 'win32' ? 'cmd' : 'posix',
  script?: string,
): FileRunTarget {
  const absolute = confined(root, file);
  const label = `Run ${basename(file)}`;
  const base = basename(file).toLowerCase();
  if (base === 'package.json' || base === 'composer.json') {
    const manager = base === 'package.json' ? undefined : 'composer';
    if (!script) return { label, manager: manager ?? 'npm', reason: 'script name is required' };
    const source = base;
    const group = groups.find((candidate) => candidate.source === source && (!manager || candidate.manager === manager));
    const runner = group?.runners.find((candidate) => candidate.label === script);
    if (!runner) return { label: `Run ${script}`, manager: group?.manager ?? manager ?? 'npm', reason: 'script is not declared in the saved manifest' };
    const cwd = rel(root, dirname(absolute));
    return { label: `Run ${script}`, manager: runner.manager, command: runner.command, cwd: cwd || undefined };
  }
  const source = content ?? (existsSync(absolute) ? readFileSync(absolute, 'utf8') : '');
  const projectTarget = resolveProjectManifestTarget(root, absolute, base, source, groups, shellFamily);
  if (projectTarget) return projectTarget;
  const simpleRuntime = base.endsWith('.php') ? { bin: 'php', manager: 'php' as const }
    : base.endsWith('.py') ? { bin: 'python', manager: 'python' as const }
      : /\.(?:js|mjs|cjs)$/i.test(base) ? { bin: 'node', manager: 'node' as const }
        : null;
  if (simpleRuntime) {
    try {
      return localSourceCommand(root, absolute, simpleRuntime.bin, simpleRuntime.manager, label, shellFamily);
    } catch (error) {
      return { label, manager: simpleRuntime.manager, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  if (file.toLowerCase().endsWith('.cs')) {
    const target = csharpProject(root, absolute);
    if (target.reason) return { label, manager: 'dotnet', reason: target.reason };
    try {
      return target.project
        ? localSourceCommand(root, target.project, 'dotnet', 'dotnet', label, shellFamily, ['run', '--project'])
        : localSourceCommand(root, absolute, 'dotnet', 'dotnet', label, shellFamily, ['run', '--file']);
    } catch (error) {
      return { label, manager: 'dotnet', reason: error instanceof Error ? error.message : String(error) };
    }
  }
  if (!file.toLowerCase().endsWith('.java')) throw new ApiError('invalid_input', 400, 'only Java and C# source files are supported');
  const packageName = /^\s*package\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/m.exec(source)?.[1];
  const className = basename(file).replace(/\.java$/i, '');
  const fqcn = packageName ? `${packageName}.${className}` : className;
  const javaGroup = groups.find((group) => group.manager === 'maven' || group.manager === 'gradle');
  if (javaGroup?.manager === 'maven') {
    const bin = javaGroup.runners.find((runner) => runner.label === 'compile')?.command.replace(/\s+compile$/, '') ?? 'mvn';
    try {
      return { label, manager: 'maven', command: `${bin} -Dexec.mainClass=${quoteShellArgument(fqcn, shellFamily)} exec:java` };
    } catch (error) {
      return { label, manager: 'maven', reason: error instanceof Error ? error.message : String(error) };
    }
  }
  if (javaGroup?.manager === 'gradle') {
    const command = javaGroup.runners.find((runner) => runner.label === 'run')?.command;
    if (command) return { label, manager: 'gradle', command };
  }
  try {
    return localSourceCommand(root, absolute, 'java', 'java', label, shellFamily);
  } catch (error) {
    return { label, manager: 'java', reason: error instanceof Error ? error.message : String(error) };
  }
}
