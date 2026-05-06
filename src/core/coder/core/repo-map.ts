/**
 * Repo-map: a compact symbol-level overview injected at the END of the
 * system prompt so the agent opens with a sense of "what's where" without
 * having to grep + read on turn 1.
 *
 * Inspired by Aider's repo-map. Two design decisions:
 *
 * 1. Off by default. Gated on `CODER_REPOMAP_TOKENS > 0` (chars budget). The
 *    map is only worth its tokens when the project is large enough that
 *    grep-and-discover would otherwise burn 2+ exploration turns. We will
 *    flip this on once the B1 telemetry shows enough sessions exhausting
 *    those turns.
 *
 * 2. Goes at the END of the system prompt, never the beginning. The map
 *    changes on every edit (file mtimes flip), so putting it at the start
 *    would invalidate the prompt-cache prefix every turn. At the END only
 *    the trailing segment is invalidated; the cache hit on the static
 *    preamble + tier hint + body stays intact.
 *
 * Selection heuristic (no LLM, pure DB queries):
 *  - Take recently-updated files first (developer's working set).
 *  - For each file, list the top-level public symbols (functions, classes,
 *    interfaces, types, enums) where parent is null.
 *  - Stop when the running char budget is exhausted.
 */
import type { CodeIndexDB } from '../../../store/db.js';

const MAX_FILES = 80;
const SYMBOLS_PER_FILE = 6;

const PUBLIC_KINDS = new Set(['function', 'class', 'interface', 'type', 'enum', 'module']);

/**
 * Build a deterministic-ish repo map for the given project. Determinism is
 * approximate — file mtimes drive ordering, so the map shifts as the
 * developer edits files. That is acceptable because the map sits at the END
 * of the system prompt (see file header) so its mutation only invalidates
 * the trailing cache segment.
 *
 * Pass `budgetChars: 0` (the default when CODER_REPOMAP_TOKENS=0) to
 * short-circuit and return an empty string.
 */
export function buildRepoMap(
  db: CodeIndexDB,
  projectId: number,
  budgetChars: number,
): string {
  if (budgetChars <= 0) return '';
  const files = db.listFiles(projectId);
  if (files.length === 0) return '';

  // Order by updated_at desc, falling back to path. Most-recently-touched
  // files surface first — they're the working set the agent is likely to
  // need on turn 1.
  const ordered = files
    .slice()
    .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? '') || a.path.localeCompare(b.path))
    .slice(0, MAX_FILES);

  const lines: string[] = [];
  let used = 0;
  let elidedFiles = 0;
  for (const f of ordered) {
    if (used >= budgetChars) {
      elidedFiles++;
      continue;
    }
    let symbols;
    try {
      symbols = db.getSymbolsByFile(projectId, f.path);
    } catch {
      continue;
    }
    const top = symbols
      .filter((s) => PUBLIC_KINDS.has(s.kind) && (s.parent === null || s.parent === ''))
      .slice(0, SYMBOLS_PER_FILE)
      .map((s) => `${s.kind} ${s.name}`)
      .join(', ');
    if (!top) continue;
    const line = `- ${f.path}: ${top}`;
    if (used + line.length + 1 > budgetChars) {
      elidedFiles++;
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }

  if (lines.length === 0) return '';
  const trailer = elidedFiles > 0
    ? `\n[repo-map: ${lines.length} files shown; ${elidedFiles} elided due to ${budgetChars}-char budget]`
    : '';
  return `# Repo map (top-level symbols, recent files first)\n${lines.join('\n')}${trailer}\n`;
}
