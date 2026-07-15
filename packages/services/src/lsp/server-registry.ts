/**
 * Catalog of installable LSP servers. Two install kinds:
 *   - 'npm'    — node-based servers, installed via npm and run with the
 *                app's managed Node (`node <entry> --stdio`).
 *   - 'binary' — native executables from pinned GitHub release assets,
 *                spawned directly (no Node, no ELECTRON_RUN_AS_NODE).
 * Versions are PINNED: one global install per `id@version` under the data
 * dir; bumping a version here installs side-by-side on the next prompt.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { initOptionsForServer, jdtJavaSettings } from './lsp-config-map.js';
import { jdtlsSpawnSpec, omnisharpSpawnSpec } from './java-csharp-launch.js';

/** `${process.platform}-${process.arch}` keys we ship binary assets for. */
export type LspTargetKey =
  | 'win32-x64' | 'win32-arm64'
  | 'darwin-x64' | 'darwin-arm64'
  | 'linux-x64' | 'linux-arm64';

const SUPPORTED_TARGETS: readonly string[] =
  ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'];

export interface LspBinaryAsset {
  url: string;
  /** Verified by the installer when present — NEVER guess; omit instead. */
  sha256?: string;
  /** Per-asset because real releases mix formats (rust-analyzer: zip on win, gz elsewhere). */
  archive: 'zip' | 'gz' | 'tar.gz' | 'none';
  /** Overrides `install.binRelPath` when this target's archive layout differs. */
  binRelPath?: string;
}

/** Extra pinned file installed beside a binary server (for example a JVM agent). */
export interface LspCompanionAsset {
  url: string;
  sha256: string;
  relPath: string;
}

export type LspInstallSpec =
  | { kind: 'npm'; package: string; version: string }
  | {
      kind: 'binary';
      version: string;
      /** Default executable path relative to the install dir ('gz'/'none' assets are written here). */
      binRelPath: string;
      assets: Partial<Record<LspTargetKey, LspBinaryAsset>>;
      companions?: readonly LspCompanionAsset[];
    };

export interface LspServerDef {
  id: string;
  label: string;
  /** language ids (shared language-id.ts) this server answers. */
  languages: string[];
  /**
   * 'primary' (default) participates in per-language routing (1 server per
   * language). 'linter' COMPLEMENTS a primary (ruff next to pyright) and is
   * reachable only by id (catalog/install/remove) — serverForLanguage skips
   * it so the existing routing never double-books a language.
   */
  role?: 'primary' | 'linter';
  install: LspInstallSpec;
  /** npm-only: server ENTRY (a .js for `node <entry> --stdio`), relative to the install dir. */
  entryRelPath?: string;
  args: string[];
  /** External runtime required before this server can start. */
  runtime?: { kind: 'java' | 'dotnet'; minMajor: number };
  /** Per-project launch builder (runtime/workspace-aware servers). */
  spawn?: (ctx: LspDynamicSpawnContext) => LspSpawnCommand;
  /** Cold-start policy. Heavy servers may refuse open/status/background warmups. */
  activation?: 'warm' | 'interactive';
  /** Some servers (OmniSharp) reject the standard workspace-folders capability. */
  workspaceFolders?: boolean;
  /** Honest download-size hint for the consent CTA. */
  sizeLabel: string;
  /** `languageLevel` = versão da linguagem escolhida p/ o projeto (undefined = default). */
  initializationOptions?: (ctx: { cacheDir: string; languageLevel?: string }) => unknown;
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
  runtime: LspRuntimeResolution;
  def: LspServerDef;
  /** Registered roots used to locate a Unity host consuming a package. */
  registeredProjectRoots?: string[];
}

// Pinned release bases (assets + layouts verified against the live releases).
const RA_BASE = 'https://github.com/rust-lang/rust-analyzer/releases/download/2025-01-20';
const RUFF_BASE = 'https://github.com/astral-sh/ruff/releases/download/0.11.13';
const JDTLS_URL = 'https://download.eclipse.org/jdtls/milestones/1.60.0/jdt-language-server-1.60.0-202606262232.tar.gz';
const JDTLS_SHA256 = 'e94c303d8198f977930803582738771fd18c52c5492878410bf222b1aa81ef1d';
const JDTLS_LAUNCHER = 'plugins/org.eclipse.equinox.launcher_1.7.200.v20260619-2039.jar';
export const JDTLS_LOMBOK_RELPATH = 'lombok/lombok-1.18.46.jar';
const JDTLS_LOMBOK_URL = 'https://projectlombok.org/downloads/lombok-1.18.46.jar';
const JDTLS_LOMBOK_SHA256 = '01f7b1a015e33e2b62d5f5f37053306357ab1415fd181fcba7794f5d198c1126';
const OMNISHARP_BASE = 'https://github.com/OmniSharp/omnisharp-roslyn/releases/download/v1.39.15';

export const LSP_SERVER_REGISTRY: readonly LspServerDef[] = [
  {
    id: 'intelephense',
    label: 'Intelephense (PHP)',
    languages: ['php'],
    install: { kind: 'npm', package: 'intelephense', version: '1.12.6' },
    entryRelPath: 'node_modules/intelephense/lib/intelephense.js',
    args: ['--stdio'],
    sizeLabel: '~25 MB',
    initializationOptions: ({ cacheDir, languageLevel }) => ({
      storagePath: join(cacheDir, 'intelephense'),
      // Versão da linguagem (env.phpVersion) — via redundante à workspace/configuration.
      ...(initOptionsForServer('intelephense', languageLevel) ?? {}),
    }),
  },
  {
    id: 'pyright',
    label: 'Pyright (Python)',
    languages: ['python'],
    install: { kind: 'npm', package: 'pyright', version: '1.1.405' },
    entryRelPath: 'node_modules/pyright/langserver.index.js',
    args: ['--stdio'],
    sizeLabel: '~50 MB',
  },
  {
    id: 'vscode-langservers',
    label: 'JSON / CSS / HTML (vscode language servers)',
    languages: ['json', 'css', 'scss', 'less', 'html'],
    install: { kind: 'npm', package: 'vscode-langservers-extracted', version: '4.10.0' },
    // One package, several servers — entry resolved per language below.
    entryRelPath: 'node_modules/vscode-langservers-extracted/bin',
    args: ['--stdio'],
    sizeLabel: '~10 MB',
  },
  {
    id: 'jdtls',
    label: 'Eclipse JDT LS (Java)',
    languages: ['java'],
    install: {
      kind: 'binary',
      version: '1.60.0',
      binRelPath: JDTLS_LAUNCHER,
      assets: Object.fromEntries(SUPPORTED_TARGETS.map((target) => [target, {
        url: JDTLS_URL,
        sha256: JDTLS_SHA256,
        archive: 'tar.gz' as const,
      }])) as Partial<Record<LspTargetKey, LspBinaryAsset>>,
      companions: [{
        url: JDTLS_LOMBOK_URL,
        sha256: JDTLS_LOMBOK_SHA256,
        relPath: JDTLS_LOMBOK_RELPATH,
      }],
    },
    args: [],
    runtime: { kind: 'java', minMajor: 21 },
    spawn: jdtlsSpawnSpec,
    sizeLabel: '~51 MB',
    initializationOptions: () => ({
      settings: { java: jdtJavaSettings() },
    }),
  },
  {
    id: 'omnisharp',
    label: 'OmniSharp (C#)',
    languages: ['csharp'],
    install: {
      kind: 'binary',
      version: '1.39.15',
      binRelPath: 'OmniSharp',
      assets: {
        'linux-arm64': { url: `${OMNISHARP_BASE}/omnisharp-linux-arm64-net6.0.tar.gz`, sha256: 'f98302d820dc60766f8cb37a4bb3da403b69c162c66c2a3c1c2ee63f89dc9b64', archive: 'tar.gz' },
        'linux-x64': { url: `${OMNISHARP_BASE}/omnisharp-linux-x64-net6.0.tar.gz`, sha256: 'e34b2ad29c31202b05dbdc1439600f98ea38acf656f84817c52e3dda81879f6c', archive: 'tar.gz' },
        'darwin-arm64': { url: `${OMNISHARP_BASE}/omnisharp-osx-arm64-net6.0.tar.gz`, sha256: 'ae9ccca3ef1c4a4a3fbae7186a02bbc6c1290d8f4e2c845a214dabaf03cd7103', archive: 'tar.gz' },
        'darwin-x64': { url: `${OMNISHARP_BASE}/omnisharp-osx-x64-net6.0.tar.gz`, sha256: 'bd2d273aff669645bdac2ee382d3a9c0220381b725a78697c9f6b6df9d22dafb', archive: 'tar.gz' },
        'win32-arm64': { url: `${OMNISHARP_BASE}/omnisharp-win-arm64-net6.0.zip`, sha256: 'b8294f77e368a85875767f8e3a82cd4f9c8de2ecc727d71d0dd378a9107c4588', archive: 'zip', binRelPath: 'OmniSharp.exe' },
        'win32-x64': { url: `${OMNISHARP_BASE}/omnisharp-win-x64-net6.0.zip`, sha256: 'b03eb6b9ac6446fce803b87c0965e94cef5570cc86f47bfefe2f60933d8658e8', archive: 'zip', binRelPath: 'OmniSharp.exe' },
      },
    },
    args: [],
    runtime: { kind: 'dotnet', minMajor: 6 },
    spawn: omnisharpSpawnSpec,
    activation: 'interactive',
    workspaceFolders: false,
    sizeLabel: '~55 MB',
  },
  {
    id: 'rust-analyzer',
    label: 'rust-analyzer (Rust)',
    languages: ['rust'],
    install: {
      kind: 'binary',
      version: '2025-01-20',
      binRelPath: 'rust-analyzer',
      assets: {
        // Windows releases are .zip (exe at archive root); the rest are single-file .gz.
        'win32-x64': { url: `${RA_BASE}/rust-analyzer-x86_64-pc-windows-msvc.zip`, sha256: 'b0a100c6631fe80b344c2a07d40e54f110603db301973c1646d6df8fb12bd721', archive: 'zip', binRelPath: 'rust-analyzer.exe' },
        'win32-arm64': { url: `${RA_BASE}/rust-analyzer-aarch64-pc-windows-msvc.zip`, sha256: '93d711b24150835cbb9345e6faf7b24699bb62072c4d7e0755da5572ca11e9d1', archive: 'zip', binRelPath: 'rust-analyzer.exe' },
        'darwin-x64': { url: `${RA_BASE}/rust-analyzer-x86_64-apple-darwin.gz`, sha256: '66d6845a0efdc9fe0f616e90ee6eb935f08eea5eb21abc1d1b632a0053de8f19', archive: 'gz' },
        'darwin-arm64': { url: `${RA_BASE}/rust-analyzer-aarch64-apple-darwin.gz`, sha256: 'a009a531104801259ff6a99f9e7ffcf1e9079c01a1ab77ce353c3cba12d63fcd', archive: 'gz' },
        'linux-x64': { url: `${RA_BASE}/rust-analyzer-x86_64-unknown-linux-gnu.gz`, sha256: 'ca8f88a5799764807c905b234452079119f0be94ba77672f9c347339d22f2b4b', archive: 'gz' },
        'linux-arm64': { url: `${RA_BASE}/rust-analyzer-aarch64-unknown-linux-gnu.gz`, sha256: '75127c950c551327cbc9a57657aa9722fc385cf048985485d480e170866d22c5', archive: 'gz' },
      },
    },
    args: [],
    sizeLabel: '~16 MB',
  },
  {
    id: 'ruff',
    label: 'Ruff (Python linter/formatter)',
    languages: ['python'],
    // COMPLEMENTS pyright (the python primary): lint/format only, spoken via `ruff server`.
    role: 'linter',
    install: {
      kind: 'binary',
      version: '0.11.13',
      binRelPath: 'ruff',
      assets: {
        // Windows zips are flat (ruff.exe); tarballs nest under a target-named dir.
        'win32-x64': { url: `${RUFF_BASE}/ruff-x86_64-pc-windows-msvc.zip`, sha256: 'd77fb4ed36392337d334bf9bcef1c5d91ec221e96c53ae8aa147e922c71ddb64', archive: 'zip', binRelPath: 'ruff.exe' },
        'win32-arm64': { url: `${RUFF_BASE}/ruff-aarch64-pc-windows-msvc.zip`, sha256: '67c4e1196d798ab8e4c0fb3fc81e3799ec9fcab1d236f286d348dcd6dfe4cfc2', archive: 'zip', binRelPath: 'ruff.exe' },
        'darwin-x64': { url: `${RUFF_BASE}/ruff-x86_64-apple-darwin.tar.gz`, sha256: '8dcc61306472f75c07af6d0446060e26227d773cee319d21900ac3a1d7bc4955', archive: 'tar.gz', binRelPath: 'ruff-x86_64-apple-darwin/ruff' },
        'darwin-arm64': { url: `${RUFF_BASE}/ruff-aarch64-apple-darwin.tar.gz`, sha256: '7d5e8feea7ee5c3962807996cad557e8a0c4d676c1cba6223bfb0e8b2ca07723', archive: 'tar.gz', binRelPath: 'ruff-aarch64-apple-darwin/ruff' },
        'linux-x64': { url: `${RUFF_BASE}/ruff-x86_64-unknown-linux-gnu.tar.gz`, sha256: '01aa32d29d00876b8d1429c617ed63a00b1fc81abfa4183bb05c9cb647fbc3d0', archive: 'tar.gz', binRelPath: 'ruff-x86_64-unknown-linux-gnu/ruff' },
        'linux-arm64': { url: `${RUFF_BASE}/ruff-aarch64-unknown-linux-gnu.tar.gz`, sha256: '551af2ebc439d8268dcaf871ea60ad035f688728d30943dcbb2bf775e105213e', archive: 'tar.gz', binRelPath: 'ruff-aarch64-unknown-linux-gnu/ruff' },
      },
    },
    args: ['server'],
    sizeLabel: '~11 MB',
  },
] as const;

export function serverForLanguage(languageId: string): LspServerDef | undefined {
  // Only PRIMARY servers take part in per-language routing — complementary
  // roles (ruff) never shadow pyright regardless of catalog order.
  return LSP_SERVER_REGISTRY.find(
    (s) => (s.role ?? 'primary') === 'primary' && s.languages.includes(languageId),
  );
}

export function serverById(id: string): LspServerDef | undefined {
  return LSP_SERVER_REGISTRY.find((s) => s.id === id);
}

export function installDirFor(baseDir: string, def: LspServerDef): string {
  return join(baseDir, `${def.id}@${def.install.version}`);
}

/** Target key for this process (null = platform without binary assets). */
export function currentTargetKey(platform = process.platform, arch = process.arch): LspTargetKey | null {
  const key = `${platform}-${arch}`;
  return SUPPORTED_TARGETS.includes(key) ? (key as LspTargetKey) : null;
}

/** Asset + effective binRelPath for a binary def on `target` (null = unsupported/not binary). */
export function binaryAssetFor(
  def: LspServerDef,
  target: LspTargetKey | null = currentTargetKey(),
): { asset: LspBinaryAsset; binRelPath: string } | null {
  if (def.install.kind !== 'binary' || !target) return null;
  const asset = def.install.assets[target];
  if (!asset) return null;
  return { asset, binRelPath: asset.binRelPath ?? def.install.binRelPath };
}

/**
 * Absolute path of what runs for (server, language): the JS entry for npm
 * defs (vscode-langservers-extracted ships one bin per language), the
 * executable for binary defs.
 */
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
  // The bin/ files are tiny node CLIs — point node at the real lib entry.
  return join(installDir, 'node_modules', 'vscode-langservers-extracted', 'bin', bin);
}

export interface LspSpawnCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Best-effort OS scheduling priority for this server process. */
  priority?: number;
  /** File whose absence means "install is broken" — gate the spawn on it. */
  checkPath: string;
  cwd?: string;
  rootPath?: string;
  workspaceMode?: 'project' | 'generated-unity' | 'generated-basic' | 'loose';
  workspaceReason?: string;
}

/**
 * How to LAUNCH a server. npm defs run `node <entry> <args>` with the
 * resolved Node; binary defs exec the executable directly. `resolveNode`
 * is only invoked for npm — binaries must NOT inherit ELECTRON_RUN_AS_NODE.
 */
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
  return { command: node.command, args: [entry, ...def.args], env: node.env, checkPath: entry };
}

export function isInstalled(baseDir: string, def: LspServerDef): boolean {
  const dir = installDirFor(baseDir, def);
  if (def.install.kind === 'binary') {
    const resolved = binaryAssetFor(def);
    return !!resolved
      && existsSync(join(dir, resolved.binRelPath))
      && (def.install.companions ?? []).every((companion) => existsSync(join(dir, companion.relPath)));
  }
  return existsSync(join(dir, 'node_modules', def.install.package.split('/')[0], 'package.json'))
    || existsSync(join(dir, 'node_modules', def.install.package));
}
