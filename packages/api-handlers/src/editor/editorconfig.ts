import { readFile, stat } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { minimatch } from 'minimatch';
import type { EditorSettingsOverride } from '@mcp/shared/editor-settings.js';

interface Section { pattern: string | null; values: Record<string, string> }
interface ParsedConfig { root: boolean; sections: Section[] }
interface CacheEntry { signature: string; result: { settings: EditorSettingsOverride; sources: string[] } }

const cache = new Map<string, CacheEntry>();

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function parse(text: string): ParsedConfig {
  const sections: Section[] = [{ pattern: null, values: {} }];
  let current = sections[0];
  let isRoot = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      current = { pattern: line.slice(1, -1).trim(), values: {} };
      sections.push(current);
      continue;
    }
    const separator = line.indexOf('=');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim().toLowerCase();
    if (current.pattern === null && key === 'root') isRoot = value === 'true';
    else current.values[key] = value;
  }
  return { root: isRoot, sections };
}

function toSettings(values: Record<string, string>): EditorSettingsOverride {
  const settings: EditorSettingsOverride = {};
  const indentStyle = values.indent_style;
  if (indentStyle === 'space') settings.insertSpaces = true;
  if (indentStyle === 'tab') settings.insertSpaces = false;
  const sizeRaw = values.indent_size === 'tab' ? values.tab_width : values.indent_size ?? values.tab_width;
  const size = Number(sizeRaw);
  if (Number.isInteger(size) && size > 0 && size <= 16) settings.tabSize = size;
  const eol = values.end_of_line;
  if (eol === 'lf' || eol === 'crlf') settings.endOfLine = eol;
  const trim = parseBoolean(values.trim_trailing_whitespace);
  if (trim !== undefined) settings.trimTrailingWhitespace = trim;
  const finalNewline = parseBoolean(values.insert_final_newline);
  if (finalNewline !== undefined) settings.insertFinalNewline = finalNewline;
  const maxLine = Number(values.max_line_length);
  if (Number.isInteger(maxLine) && maxLine >= 40 && maxLine <= 500) {
    settings.rulers = [maxLine];
    settings.wordWrapColumn = maxLine;
  }
  return settings;
}

export async function resolveEditorConfig(projectRoot: string, file: string): Promise<{ settings: EditorSettingsOverride; sources: string[] }> {
  const root = resolve(projectRoot);
  const absolute = resolve(root, file);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) throw new Error('file escapes project root');

  const dirs: string[] = [];
  let cursor = dirname(absolute);
  while (cursor === root || cursor.startsWith(`${root}${sep}`)) {
    dirs.unshift(cursor);
    if (cursor === root) break;
    cursor = dirname(cursor);
  }

  const candidates: Array<{ path: string; mtimeMs: number; size: number }> = [];
  for (const dir of dirs) {
    const path = resolve(dir, '.editorconfig');
    try {
      const info = await stat(path);
      if (info.isFile()) candidates.push({ path, mtimeMs: info.mtimeMs, size: info.size });
    } catch { /* missing config is part of the rescan/invalidation */ }
  }
  const signature = candidates.map((item) => `${item.path}:${item.mtimeMs}:${item.size}`).join('|');
  const key = `${root}\0${file.replace(/\\/g, '/')}`;
  const previous = cache.get(key);
  if (previous?.signature === signature) return previous.result;

  let merged: EditorSettingsOverride = {};
  const sources: string[] = [];
  for (const candidate of candidates) {
    const parsed = parse(await readFile(candidate.path, 'utf8'));
    if (parsed.root) { merged = {}; sources.length = 0; }
    const rel = relative(dirname(candidate.path), absolute).replace(/\\/g, '/');
    let values: Record<string, string> = {};
    for (const section of parsed.sections) {
      const matches = section.pattern === null || minimatch(rel, section.pattern, { dot: true, matchBase: !section.pattern.includes('/') });
      if (!matches) continue;
      values = { ...values, ...section.values };
    }
    merged = { ...merged, ...toSettings(values) };
    sources.push(relative(root, candidate.path).replace(/\\/g, '/') || '.editorconfig');
  }
  const result = { settings: merged, sources };
  cache.set(key, { signature, result });
  return result;
}

export function clearEditorConfigCache(projectId?: number): void {
  if (projectId === undefined) cache.clear();
  // Cache keys intentionally use roots instead of ids; mtime rescans make an
  // explicit project-id purge unnecessary for correctness.
}
