/**
 * Literal/regex text grep over a project's indexed files — the engine behind
 * IntelliJ-style "Find in Files". No ripgrep dependency: we read each indexed
 * file and scan line-by-line, returning per-match positions so the UI can
 * highlight the exact span. Bounded by `maxMatches` to stay responsive.
 *
 * Corpus = `db.listFiles` (the indexed set already excludes node_modules/.git),
 * filtered by an optional comma-separated glob mask (e.g. `*.tsx, *.ts`).
 */
import { boundedGrep } from '@mcp/services/services/bounded-grep.js';
import { discoverLivePaths } from '@mcp/indexer/indexer/live-paths.js';
import { projectIndexIgnorePatterns } from '@mcp/shared/utils/index-ignore.js';

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
  coverage?: { complete: boolean; examinedFiles: number; skippedFiles: number; skippedLines: number; changedFiles: number; discoveredFiles: number; failedRoots: number };
  freshness?: { mode: 'live_disk'; observedAt: string; finishedAt: string; snapshot: false };
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
  signal?: AbortSignal;
}

interface FileLister {
  getProject(id: number): { root_path: string; index_ignore_patterns?: string | null } | null | undefined;
  listFiles(id: number): Array<{ path: string }>;
}

const RE_SPECIAL = /[.*+?^${}()|[\]\\]/g;
function escapeRe(s: string): string {
  return s.replace(RE_SPECIAL, '\\$&');
}

/**
 * Build the search RegExp (global, multiline) or null when invalid/empty. The
 * `m` flag makes `^`/`$` anchor per-line, so a regex like `;$` behaves the same
 * in the line-by-line grep AND in the whole-content replace (no anchor drift).
 */
export function buildMatcher(o: GrepOptions): RegExp | null {
  if (!o.query) return null;
  let src = o.regex ? o.query : escapeRe(o.query);
  if (o.wholeWord) src = `\\b(?:${src})\\b`;
  try {
    return new RegExp(src, 'gm' + (o.caseSensitive ? '' : 'i'));
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

  o.signal?.throwIfAborted();
  const observedAt = new Date().toISOString();
  const maskRe = maskToRe(o.mask);
  const sources = [{ rootPath: project.root_path, prefix: '', ignorePatterns: projectIndexIgnorePatterns(project) }];
  const indexed = db.listFiles(projectId).map(f => f.path);
  const disk = await discoverLivePaths(sources, { exclude: new Set(indexed), signal: o.signal });
  const paths = [...indexed, ...disk.paths].filter(p => !maskRe || maskRe.test(baseName(p)));
  const scan = await boundedGrep({ sources, paths, pattern: matcher, maxMatches: o.maxMatches ?? 2000, maxLineLen: o.maxLineLen, signal: o.signal });
  const grouped = new Map<string, GrepFile>();
  for (const { file, ...match } of scan.matches) {
    let entry = grouped.get(file);
    if (!entry) { entry = { path: file, matches: [] }; grouped.set(file, entry); }
    entry.matches.push(match);
  }
  const complete = !scan.truncated && !disk.truncated && !disk.failedRoots && !scan.skippedFiles && !scan.skippedLines && !scan.changedFiles;
  return { files: [...grouped.values()], total: scan.matches.length, fileCount: grouped.size, truncated: !complete,
    coverage: { complete, examinedFiles: scan.examinedFiles, skippedFiles: scan.skippedFiles, skippedLines: scan.skippedLines, changedFiles: scan.changedFiles, discoveredFiles: disk.paths.length, failedRoots: disk.failedRoots },
    freshness: { mode: 'live_disk', observedAt, finishedAt: new Date().toISOString(), snapshot: false },
  };
}
