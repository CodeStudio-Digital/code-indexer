/**
 * Replace-in-files engine — applies the same matcher the grep uses, writes the
 * changed files, and marks them dirty so the index re-extracts. Literal mode
 * escapes `$` in the replacement so `$1` isn't read as a backref; regex mode
 * passes the replacement through so `$1`/`$&` group substitution works.
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { buildMatcher, maskToRe, type GrepOptions } from './text-grep.js';

export interface ReplaceOptions extends GrepOptions {
  replacement: string;
  /** Restrict to these project-relative paths (e.g. some files deselected). */
  files?: string[];
}
export interface ReplaceResult {
  replaced: number;
  fileCount: number;
}

interface ReplaceDeps {
  getProject(id: number): { root_path: string } | null | undefined;
  listFiles(id: number): Array<{ path: string }>;
}

function baseName(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

export async function replaceInProject(
  db: ReplaceDeps,
  markDirty: ((projectId: number, changes: Array<{ path: string; kind: 'upsert' }>) => void) | undefined,
  projectId: number,
  o: ReplaceOptions,
): Promise<ReplaceResult> {
  const project = db.getProject(projectId);
  const matcher = buildMatcher(o);
  if (!project || !matcher) return { replaced: 0, fileCount: 0 };

  const root = path.resolve(project.root_path);
  const maskRe = maskToRe(o.mask);
  const scope = o.files && o.files.length > 0
    ? o.files
    : db.listFiles(projectId).map((f) => f.path).filter((p) => !maskRe || maskRe.test(baseName(p)));

  const repl = o.regex ? o.replacement : o.replacement.replace(/\$/g, '$$$$');
  const NUL = String.fromCharCode(0);

  let replaced = 0;
  let fileCount = 0;
  const dirty: Array<{ path: string; kind: 'upsert' }> = [];

  for (const rel of scope) {
    const abs = path.resolve(root, rel);
    let content: string;
    try {
      content = await fs.readFile(abs, 'utf8');
    } catch {
      continue;
    }
    if (content.includes(NUL)) continue;

    let count = 0;
    matcher.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = matcher.exec(content)) !== null) {
      count++;
      if (m[0].length === 0) matcher.lastIndex++;
    }
    if (count === 0) continue;

    matcher.lastIndex = 0;
    const next = content.replace(matcher, repl);
    if (next === content) continue;

    await fs.writeFile(abs, next, 'utf8');
    replaced += count;
    fileCount++;
    dirty.push({ path: rel.replace(/\\/g, '/'), kind: 'upsert' });
  }

  if (dirty.length > 0 && markDirty) {
    try { markDirty(projectId, dirty); } catch { /* re-index is best-effort */ }
  }
  return { replaced, fileCount };
}
