import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { dirname, join } from 'node:path';
import { isUnityProjectRoot } from '@mcp/shared/utils/project-ignore.js';
import { binaryAssetFor } from './server-spawn.js';
import { JDTLS_LOMBOK_RELPATH } from './lsp-server-constants.js';
import type { LspDynamicSpawnContext, LspSpawnCommand } from './lsp-server-types.js';
import { resolveCsharpWorkspace } from './csharp-workspace.js';

function requireRuntime(ctx: LspDynamicSpawnContext): { command: string; env?: Record<string, string> } {
  if (!ctx.runtime?.satisfied || !ctx.runtime.command) {
    throw new Error(ctx.runtime?.reason ?? `${ctx.def.runtime?.kind ?? 'required'} runtime is unavailable`);
  }
  return { command: ctx.runtime.command, env: ctx.runtime.env };
}

export function jdtConfigName(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string {
  if (platform === 'win32') return 'config_win';
  if (platform === 'darwin') return arch === 'arm64' ? 'config_mac_arm' : 'config_mac';
  return arch === 'arm64' ? 'config_linux_arm' : 'config_linux';
}

export function jdtlsSpawnSpec(ctx: LspDynamicSpawnContext): LspSpawnCommand {
  const runtime = requireRuntime(ctx);
  const launcher = join(ctx.installDir, binaryAssetFor(ctx.def)!.binRelPath);
  const lombokAgent = join(ctx.installDir, JDTLS_LOMBOK_RELPATH);
  const workspace = join(ctx.baseDir, '.workspaces', `${ctx.def.id}@${ctx.def.install.version}`, String(ctx.projectId));
  const configuration = join(workspace, 'configuration');
  const data = join(workspace, 'data');
  const configIni = join(configuration, 'config.ini');
  if (!existsSync(configIni)) {
    rmSync(configuration, { recursive: true, force: true });
    mkdirSync(dirname(configuration), { recursive: true });
    cpSync(join(ctx.installDir, jdtConfigName()), configuration, { recursive: true });
  }
  mkdirSync(data, { recursive: true });
  return {
    command: runtime.command,
    env: runtime.env,
    checkPath: launcher,
    args: [
      '-Declipse.application=org.eclipse.jdt.ls.core.id1',
      '-Dosgi.bundles.defaultStartLevel=4',
      '-Declipse.product=org.eclipse.jdt.ls.core.product',
      '-Dlog.protocol=true',
      '-Dlog.level=INFO',
      '-Xmx1G',
      '--add-modules=ALL-SYSTEM',
      '--add-opens', 'java.base/java.util=ALL-UNNAMED',
      '--add-opens', 'java.base/java.lang=ALL-UNNAMED',
      `-javaagent:${lombokAgent}`,
      '-jar', launcher,
      '-configuration', configuration,
      '-data', data,
    ],
  };
}

function omnisharpDiagnosticWorkers(): number {
  const value = Number(process.env.MCP_OMNISHARP_DIAGNOSTIC_WORKERS);
  return Number.isInteger(value) && value > 0 ? Math.min(value, 64) : 1;
}

export function omnisharpSpawnSpec(ctx: LspDynamicSpawnContext): LspSpawnCommand {
  const runtime = requireRuntime(ctx);
  const bin = join(ctx.installDir, binaryAssetFor(ctx.def)!.binRelPath);
  const unityRoot = isUnityProjectRoot(ctx.projectRoot);
  // On-demand load applies to EVERY solution, not only Unity: an eager
  // MSBuild design-time load of a large solution (10k+ files) keeps Roslyn
  // busy for minutes and every LSP request answers at its timeout, freezing
  // the shared main loop. On-demand loads the project owning the opened file
  // plus its references — reverse dependencies stay unloaded, so
  // cross-project find-references may be incomplete until those load.
  // MCP_OMNISHARP_ONDEMAND=0 restores the eager whole-solution semantics
  // (Unity keeps on-demand regardless — hundreds of generated projects).
  const workspace = resolveCsharpWorkspace({
    sourceRoot: ctx.projectRoot,
    baseDir: ctx.baseDir,
    projectId: ctx.projectId,
    serverVersion: ctx.def.install.version,
    registeredProjectRoots: ctx.registeredProjectRoots,
    dotnetRoot: dirname(runtime.command),
  });
  // Generated workspaces contain one tiny project whose Compile items point
  // back to the source tree. On-demand mode skips loading it and therefore
  // cannot discover which project owns an external absolute file URI.
  const onDemand = workspace.mode === 'project'
    && (unityRoot || process.env.MCP_OMNISHARP_ONDEMAND !== '0');
  return {
    command: bin,
    checkPath: bin,
    env: runtime.env,
    priority: osConstants.priority.PRIORITY_BELOW_NORMAL,
    cwd: workspace.cwd,
    rootPath: workspace.rootPath,
    workspaceMode: workspace.mode,
    workspaceReason: workspace.reason,
    args: [
      '-z',
      '--hostPID', String(process.pid),
      'DotNet:enablePackageRestore=false',
      'MSBuild:EnablePackageAutoRestore=false',
      ...(onDemand ? ['MSBuild:LoadProjectsOnDemand=true'] : []),
      // Whole-solution background analysis floods publishDiagnostics with one
      // notification per file across the entire codebase; scope analysis to
      // the buffers the user actually opened (same as VS Code's
      // `omnisharp.analyzeOpenDocumentsOnly`).
      'RoslynExtensionsOptions:AnalyzeOpenDocumentsOnly=true',
      `RoslynExtensionsOptions:DiagnosticWorkersThreadCount=${omnisharpDiagnosticWorkers()}`,
      '--encoding', 'utf-8',
      '--languageserver',
    ],
  };
}
