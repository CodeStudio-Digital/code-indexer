/** Shared contracts for installable and dynamically routed language servers. */
export type LspTargetKey =
  | 'win32-x64' | 'win32-arm64'
  | 'darwin-x64' | 'darwin-arm64'
  | 'linux-x64' | 'linux-arm64';

export const SUPPORTED_LSP_TARGETS: readonly LspTargetKey[] = [
  'win32-x64', 'win32-arm64',
  'darwin-x64', 'darwin-arm64',
  'linux-x64', 'linux-arm64',
];

export interface LspBinaryAsset {
  url: string;
  /** Verified by the installer when present. Omit rather than guessing. */
  sha256?: string;
  archive: 'zip' | 'gz' | 'tar.gz' | 'none';
  binRelPath?: string;
}

export interface LspCompanionAsset {
  url: string;
  sha256: string;
  relPath: string;
}

export type LspInstallSpec =
  | { kind: 'npm'; package: string; version: string; integrity?: string }
  | {
      kind: 'binary';
      version: string;
      binRelPath: string;
      assets: Partial<Record<LspTargetKey, LspBinaryAsset>>;
      companions?: readonly LspCompanionAsset[];
    };

export interface LspActivationRule {
  whenFiles?: string[];
  whenPackageDep?: string[];
}

export interface LspRuntimeResolution {
  kind: 'java' | 'dotnet';
  minMajor: number;
  satisfied: boolean;
  version?: string;
  command?: string;
  env?: Record<string, string>;
  reason?: string;
}

export interface LspDynamicSpawnContext {
  installDir: string;
  baseDir: string;
  projectId: number;
  projectRoot: string;
  languageId: string;
  runtime?: LspRuntimeResolution;
  def: LspServerDef;
  registeredProjectRoots?: string[];
}

export interface LspSpawnCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
  priority?: number;
  checkPath: string;
  cwd?: string;
  rootPath?: string;
  workspaceMode?: 'project' | 'generated-unity' | 'generated-basic' | 'loose';
  workspaceReason?: string;
}

export interface LspServerDef {
  id: string;
  /** Stable install-directory key; profile ids may vary while storage is shared. */
  storageId?: string;
  label: string;
  languages: string[];
  role?: 'primary' | 'linter' | 'overlay';
  install: LspInstallSpec;
  entryRelPath?: string;
  args: string[];
  launchKind?: 'standard' | 'angular';
  runtime?: { kind: 'java' | 'dotnet'; minMajor: number };
  spawn?: (ctx: LspDynamicSpawnContext) => LspSpawnCommand;
  activation?: 'warm' | 'interactive';
  workspaceFolders?: boolean;
  sizeLabel: string;
  initializationOptions?: (ctx: { cacheDir: string; languageLevel?: string }) => unknown;
  projectActivation?: LspActivationRule;
  pluginNamespace?: string;
  priority?: number;
  /** Logical family and compatibility profile for version-aware servers. */
  familyId?: string;
  profileId?: string;
  projectRange?: string;
  supportTier?: 'full' | 'best-effort' | 'unsupported';
  serverNodeRange?: string;
  typescriptRange?: string;
  languageServiceVersion?: string;
  projectResolver?: 'angular-core';
  /** Profile matching the contribution's backwards-compatible install fallback. */
  defaultProfile?: boolean;
}
