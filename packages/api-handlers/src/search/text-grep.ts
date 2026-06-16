/**
 * Literal/regex text grep over a project's indexed files — the engine behind
 * IntelliJ-style "Find in Files". No ripgrep dependency: we read each indexed
 * file and scan line-by-line, returning per-match positions so the UI can
 * highlight the exact span. Bounded by `maxMatches` to stay responsive.
 *
 * Corpus = `db.listFiles` (the indexed set already excludes node_modules/.git),
 * filtered by an optional comma-separated glob mask (e.g. `*.tsx, *.ts`).
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';

export interface GrepMatch {
  line: number; // 1-based
  text: string; // the full source line
  start: number; // match offset within `text`
  end: number;
}
export interface GrepFile {
  path: string;
  matches: GrepMatch[];
}
export interface GrepResult {
  files: GrepFile[];
  total: number;
  fileCount: number;
  truncated: boolean;
}

export interface GrepOptions {
  query: string;
  regex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  /** Comma-separated globs matched against the basename. Empty = all files. */
  mask?: string;
  maxMatches?: number;
  /** Skip lines longer than this (minified bundles). */
  maxLineLen?: number;
}

interface FileLister {
  getProject(id: number): { root_path: string } | null | undefined;
  listFiles(id: number): Array<{ path: string }>;
}

const RE_SPECIAL = /[.*+?^${}()|[\]\\]/g;
function escapeRe(s: string): string {
  return s.replace(RE_SPECIAL, '\\$&');
}

/** Build the search RegExp (global) or null when the input is invalid/empty. */
export function buildMatcher(o: GrepOptions): RegExp | null {
  if (!o.query) return null;
  let src = o.regex ? o.query : escapeRe(o.query);
  if (o.wholeWord) src = `\\b(?:${src})\\b`;
  try {
    return new RegExp(src, 'g' + (o.caseSensitive ? '' : 'i'));
  } catch {
    return null;
  }
}

/** Compile a comma-separated glob mask into a basename matcher, or null. */
export function maskToRe(mask?: string): RegExp | null {
  const parts = (mask ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const alts = parts.map((p) => '^' + p.split('*').map(escapeRe).join('.*') + '$');
  try {
    return new RegExp(alts.join('|'), 'i');
  } catch {
    return null;
  }
}

function baseName(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

export async function grepProject(db: FileLister, projectId: number, o: GrepOptions): Promise<GrepResult> {
  const empty: GrepResult = { files: [], total: 0, fileCount: 0, truncated: false };
  const project = db.getProject(projectId);
  const matcher = buildMatcher(o);
  if (!project || !matcher) return empty;

  const maskRe = maskToRe(o.mask);
  const maxMatches = o.maxMatches ?? 2000;
  const maxLineLen = o.maxLineLen ?? 1000;
  const root = path.resolve(project.root_path);

  const files = db
    .listFiles(projectId)
    .map((f) => f.path)
    .filter((p) => !maskRe || maskRe.test(baseName(p)));

  const out: GrepFile[] = [];
  let total = 0;
  let truncated = false;

  for (const rel of files) {
    if (total >= maxMatches) { truncated = true; break; }
    let content: string;
    try {
      content = await fs.readFile(path.resolve(root, rel), 'utf8');
    } catch {
      continue;
    }
    if (content.includes(String.fromCharCode(0))) continue; // skip binary files
    const lines = content.split('\n');
    const fileMatches: GrepMatch[] = [];
    for (let i = 0; i < lines.length && total < maxMatches; i++) {
      const text = lines[i];
      if (text.length > maxLineLen) continue;
      matcher.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = matcher.exec(text)) !== null) {
        fileMatches.push({ line: i + 1, text, start: m.index, end: m.index + m[0].length });
        total++;
        if (m[0].length === 0) matcher.lastIndex++; // guard zero-width loop
        if (total >= maxMatches) { truncated = true; break; }
      }
    }
    if (fileMatches.length) out.push({ path: rel, matches: fileMatches });
  }

  return { files: out, total, fileCount: out.length, truncated };
}
