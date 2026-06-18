/**
 * Material Icon Theme resolver — mapeia nome de arquivo/pasta → URL do SVG
 * vendorizado (algoritmo de icon-theme do VSCode: fileNames → extensão
 * encadeada mais longa → default; folderNames[Expanded] → default).
 *
 * Os SVGs entram via import.meta.glob(?url) → URLs hasheadas em /assets/*
 * (mesmo mecanismo do resto do bundle, funciona sob o protocolo Electron).
 * `manifest.generated.json` e `svg/` são produzidos por scripts/fetch-material-icons.mjs.
 */
import manifestJson from './manifest.generated.json';

interface IconManifest {
  version: string;
  fileNames: Record<string, string>;
  fileExtensions: Record<string, string>;
  folderNames: Record<string, string>;
  folderNamesExpanded: Record<string, string>;
  defaults: { file: string; folder: string; folderExpanded: string };
}

const manifest = manifestJson as IconManifest;

const URLS = import.meta.glob('./svg/*.svg', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>;

function urlForStem(stem: string): string | null {
  return URLS[`./svg/${stem}.svg`] ?? null;
}

/**
 * Stem do SVG para um arquivo (PURO — só o manifest, sem glob/URL). Testável.
 * fileNames → extensão encadeada mais longa → default 'file'.
 */
export function stemForFile(nameOrPath: string): string {
  const name = (nameOrPath.split(/[/\\]/).pop() ?? nameOrPath).toLowerCase();
  const byName = manifest.fileNames[name];
  if (byName) return byName;
  const parts = name.split('.');
  for (let i = 1; i < parts.length; i++) {
    const def = manifest.fileExtensions[parts.slice(i).join('.')];
    if (def) return def;
  }
  return manifest.defaults.file;
}

/** Stem do SVG para uma pasta (PURO). folderNames[Expanded] → default. */
export function stemForFolder(name: string, expanded: boolean): string {
  const map = expanded ? manifest.folderNamesExpanded : manifest.folderNames;
  return map[name.toLowerCase()] ?? (expanded ? manifest.defaults.folderExpanded : manifest.defaults.folder);
}

const fileCache = new Map<string, string | null>();

export function materialIconForFile(nameOrPath: string): string | null {
  const name = (nameOrPath.split(/[/\\]/).pop() ?? nameOrPath).toLowerCase();
  const cached = fileCache.get(name);
  if (cached !== undefined) return cached;
  // Stem resolvido pode não ter SVG copiado → cai no default 'file'.
  const result = urlForStem(stemForFile(name)) ?? urlForStem(manifest.defaults.file);
  fileCache.set(name, result);
  return result;
}

export function materialIconForFolder(name: string, expanded: boolean): string | null {
  return (
    urlForStem(stemForFolder(name, expanded)) ??
    urlForStem(expanded ? manifest.defaults.folderExpanded : manifest.defaults.folder)
  );
}
