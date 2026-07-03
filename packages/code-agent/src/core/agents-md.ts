/**
 * AGENTS.md discovery + loading.
 *
 * Mirrors Codex's `agents_md.rs`: walk from the project root DOWN to the
 * working directory (inclusive), pick at most one instruction file per
 * directory (`AGENTS.override.md` preferred over `AGENTS.md`), and concatenate
 * their contents in root→cwd order so more-specific (deeper) instructions come
 * last. Our `/init` skill already GENERATES `AGENTS.md` — this is the missing
 * consumer that reads it back and surfaces it to the model.
 *
 * Read-only + budget-capped. Session-fixed content → the caller renders it in
 * the cache-stable static prefix. Any I/O error on a single file is skipped,
 * never thrown, so a malformed workspace can't break session start.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/** Per-directory candidates, in precedence order (first match wins per dir). */
const CANDIDATE_FILENAMES = ['AGENTS.override.md', 'AGENTS.md'] as const;

/** Total byte budget across all discovered files (matches Codex's cap intent). */
const MAX_TOTAL_BYTES = 32 * 1024;

/** Directories from `root` down to `cwd`, inclusive. `[root]` when cwd===root. */
function dirsRootToCwd(root: string, cwd: string): string[] {
  const r = resolve(root);
  const c = resolve(cwd);
  const rel = relative(r, c);
  // cwd is not under root (or is root itself) → only scan the root.
  if (rel === '' || rel.startsWith('..')) return [r];
  const dirs = [r];
  let cursor = r;
  for (const part of rel.split(sep)) {
    if (!part) continue;
    cursor = join(cursor, part);
    dirs.push(cursor);
  }
  return dirs;
}

/**
 * Load the hierarchical AGENTS.md instructions for a session. Returns the
 * concatenated text (root→cwd order) or '' when nothing is found.
 *
 * @param projectRoot absolute project root
 * @param cwd effective working directory (defaults to projectRoot — single
 *   IDE sessions operate at the project root; deeper cwd is honoured when passed)
 */
export function loadAgentsMd(projectRoot: string, cwd: string = projectRoot): string {
  let remaining = MAX_TOTAL_BYTES;
  const chunks: string[] = [];

  for (const dir of dirsRootToCwd(projectRoot, cwd)) {
    if (remaining <= 0) break;
    for (const name of CANDIDATE_FILENAMES) {
      const candidate = join(dir, name);
      let raw: string;
      try {
        if (!existsSync(candidate)) continue;
        raw = readFileSync(candidate, 'utf8');
      } catch {
        continue; // unreadable / non-utf8 — skip, never throw
      }
      const text = raw.length > remaining ? raw.slice(0, remaining) : raw;
      if (text.trim()) {
        chunks.push(text.trimEnd());
        remaining -= Buffer.byteLength(text, 'utf8');
      }
      break; // one file per directory (override wins)
    }
  }

  return chunks.join('\n\n');
}
