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
import { initOptionsForServer } from './lsp-config-map.js';

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

export type LspInstallSpec =
  | { kind: 'npm'; package: string; version: string }
  | {
      kind: 'binary';
      version: string;
      /** Default executable path relative to the install dir ('gz'/'none' assets are written here). */
      binRelPath: string;
      assets: Partial<Record<LspTargetKey, LspBinaryAsset>>;
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
  /** Honest download-size hint for the consent CTA. */
  sizeLabel: string;
  /** `languageLevel` = versão da linguagem escolhida p/ o projeto (undefined = default). */
  initializationOptions?: (ctx: { cacheDir: string; languageLevel?: string }) => unknown;
}

// Pinned release bases (assets + layouts verified against the live releases).
const RA_BASE = 'https://github.com/rust-lang/rust-analyzer/releases/download/2025-01-20';
const RUFF_BASE = 'https://github.com/astral-sh/ruff/releases/download/0.11.13';

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
  /** File whose absence means "install is broken" — gate the spawn on it. */
  checkPath: string;
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
): LspSpawnCommand {
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
    return !!resolved && existsSync(join(dir, resolved.binRelPath));
  }
  return existsSync(join(dir, 'node_modules', def.install.package.split('/')[0], 'package.json'))
    || existsSync(join(dir, 'node_modules', def.install.package));
}
