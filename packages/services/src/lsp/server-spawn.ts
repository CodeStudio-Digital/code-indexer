/** Filesystem layout and launch commands for an effective server definition. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SUPPORTED_LSP_TARGETS,
  type LspBinaryAsset,
  type LspDynamicSpawnContext,
  type LspServerDef,
  type LspSpawnCommand,
  type LspTargetKey,
} from './lsp-server-types.js';

export function installDirFor(baseDir: string, def: LspServerDef): string {
  return join(baseDir, `${def.storageId ?? def.id}@${def.install.version}`);
}

export function currentTargetKey(platform = process.platform, arch = process.arch): LspTargetKey | null {
  const key = `${platform}-${arch}` as LspTargetKey;
  return SUPPORTED_LSP_TARGETS.includes(key) ? key : null;
}

export function binaryAssetFor(
  def: LspServerDef,
  target: LspTargetKey | null = currentTargetKey(),
): { asset: LspBinaryAsset; binRelPath: string } | null {
  if (def.install.kind !== 'binary' || !target) return null;
  const asset = def.install.assets[target];
  return asset ? { asset, binRelPath: asset.binRelPath ?? def.install.binRelPath } : null;
}

export function entryFor(installDir: string, def: LspServerDef, languageId: string): string {
  if (def.install.kind === 'binary') {
    return join(installDir, binaryAssetFor(def)?.binRelPath ?? def.install.binRelPath);
  }
  if (def.id !== 'vscode-langservers') {
    if (!def.entryRelPath) throw new Error(`LSP server ${def.id} (npm) is missing entryRelPath`);
    return join(installDir, def.entryRelPath);
  }
  const byLang: Record<string, string> = {
    json: 'vscode-json-language-server',
    css: 'vscode-css-language-server',
    scss: 'vscode-css-language-server',
    less: 'vscode-css-language-server',
    html: 'vscode-html-language-server',
  };
  const bin = byLang[languageId] ?? 'vscode-json-language-server';
  return join(installDir, 'node_modules', 'vscode-langservers-extracted', 'bin', bin);
}

export function spawnSpecFor(
  def: LspServerDef,
  installDir: string,
  resolveNode: () => { command: string; env?: Record<string, string> },
  languageId: string = def.languages[0],
  dynamic?: Omit<LspDynamicSpawnContext, 'def' | 'installDir' | 'languageId'>,
): LspSpawnCommand {
  if (def.spawn) {
    if (!dynamic) throw new Error(`LSP server ${def.id} needs a dynamic spawn context`);
    return def.spawn({ ...dynamic, def, installDir, languageId });
  }
  if (def.install.kind === 'binary') {
    const bin = entryFor(installDir, def, languageId);
    return { command: bin, args: [...def.args], checkPath: bin };
  }
  const node = resolveNode();
  const entry = entryFor(installDir, def, languageId);
  if (def.launchKind !== 'angular') {
    return { command: node.command, args: [entry, ...def.args], env: node.env, checkPath: entry };
  }
  if (!dynamic) throw new Error(`Angular language server ${def.id} needs a project context`);
  const serverModules = join(installDir, 'node_modules');
  const projectModules = join(dynamic.projectRoot, 'node_modules');
  return {
    command: node.command,
    args: [
      entry,
      '--stdio',
      '--ngProbeLocations', `${projectModules},${serverModules}`,
      '--tsProbeLocations', `${projectModules},${serverModules}`,
      ...def.args,
    ],
    env: node.env,
    checkPath: entry,
    cwd: dynamic.projectRoot,
    rootPath: dynamic.projectRoot,
  };
}

/** Validate the exact npm artifact represented by an effective definition. */
export function validateNpmServerInstall(root: string, def: LspServerDef): string | null {
  if (def.install.kind !== 'npm') return 'expected an npm language server';
  try {
    const packagePath = join(root, 'node_modules', ...def.install.package.split('/'), 'package.json');
    const manifest = JSON.parse(readFileSync(packagePath, 'utf8')) as {
      name?: string;
      version?: string;
    };
    if (manifest.name !== def.install.package || manifest.version !== def.install.version) {
      return `installed package mismatch: expected ${def.install.package}@${def.install.version}`;
    }
    if (!def.entryRelPath || !existsSync(join(root, def.entryRelPath))) {
      return `npm reported success but server entry ${def.entryRelPath ?? '(missing)'} was not found`;
    }
    if (def.install.integrity) {
      const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as {
        packages?: Record<string, { integrity?: string }>;
      };
      const key = `node_modules/${def.install.package}`;
      if (lock.packages?.[key]?.integrity !== def.install.integrity) {
        return 'installed package integrity mismatch';
      }
    }
    return null;
  } catch (error) {
    return `installed package validation failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function isInstalled(baseDir: string, def: LspServerDef): boolean {
  const dir = installDirFor(baseDir, def);
  if (def.install.kind === 'binary') {
    const resolved = binaryAssetFor(def);
    return !!resolved
      && existsSync(join(dir, resolved.binRelPath))
      && (def.install.companions ?? []).every((item) => existsSync(join(dir, item.relPath)));
  }
  return validateNpmServerInstall(dir, def) === null;
}
