/**
 * Utilitários de fs do studio-audit: walk recursivo de fontes com filtro de
 * extensão e leitura tolerante (arquivo sumiu no meio do audit ≠ crash).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.cache', '_analysis']);

export interface ScannedFile {
  /** Caminho relativo à raiz passada (separador /). */
  rel: string;
  text: string;
}

export function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Lê todos os arquivos sob `root` com extensão em `exts` (ex.: ['.tsx']). */
export function scanFiles(root: string, exts: readonly string[]): ScannedFile[] {
  const out: ScannedFile[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(abs);
        continue;
      }
      if (!exts.includes(extname(entry.name).toLowerCase())) continue;
      const text = readIfExists(abs);
      if (text != null) out.push({ rel: relative(root, abs).replaceAll('\\', '/'), text });
    }
  };
  walk(root);
  return out;
}

/** Número da linha (1-based) do offset no texto. */
export function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}
