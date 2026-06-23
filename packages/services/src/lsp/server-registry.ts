/**
 * Catalog of installable LSP servers (tier 1 — node-based, runnable with
 * the app's managed Node). Versions are PINNED: one global install per
 * `id@version` under the data dir; bumping a version here installs
 * side-by-side on the next prompt.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { initOptionsForServer } from './lsp-config-map.js';

export interface LspServerDef {
  id: string;
  label: string;
  /** language ids (shared language-id.ts) this server answers. */
  languages: string[];
  install: { kind: 'npm'; package: string; version: string };
  /** Path of the server ENTRY (a .js for `node <entry> --stdio`), relative to the install dir. */
  entryRelPath: string;
  args: string[];
  /** Honest download-size hint for the consent CTA. */
  sizeLabel: string;
  /** `languageLevel` = versão da linguagem escolhida p/ o projeto (undefined = default). */
  initializationOptions?: (ctx: { cacheDir: string; languageLevel?: string }) => unknown;
}

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
] as const;

export function serverForLanguage(languageId: string): LspServerDef | undefined {
  return LSP_SERVER_REGISTRY.find((s) => s.languages.includes(languageId));
}

export function serverById(id: string): LspServerDef | undefined {
  return LSP_SERVER_REGISTRY.find((s) => s.id === id);
}

export function installDirFor(baseDir: string, def: LspServerDef): string {
  return join(baseDir, `${def.id}@${def.install.version}`);
}

/**
 * Absolute JS entry for (server, language). vscode-langservers-extracted
 * ships one binary per language; the others have a single entry.
 */
export function entryFor(installDir: string, def: LspServerDef, languageId: string): string {
  if (def.id !== 'vscode-langservers') return join(installDir, def.entryRelPath);
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

export function isInstalled(baseDir: string, def: LspServerDef): boolean {
  return existsSync(join(installDirFor(baseDir, def), 'node_modules', def.install.package.split('/')[0], 'package.json'))
    || existsSync(join(installDirFor(baseDir, def), 'node_modules', def.install.package));
}
