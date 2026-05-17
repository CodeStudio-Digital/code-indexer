/**
 * Repo-map: a compact symbol-level overview injected at the END of the
 * system prompt so the agent opens with a sense of "what's where" without
 * having to grep + read on turn 1.
 *
 * Inspired by Aider's repo-map. Two design decisions:
 *
 * 1. Auto-sized by default. Use `resolveRepoMapBudget` to pick a char budget
 *    from the indexed file count — tiny projects get nothing (grep is
 *    faster), medium projects pay ~400 tokens, large projects up to ~1100.
 *    The map is only worth its tokens when grep-and-discover would
 *    otherwise burn 2+ exploration turns. Honor `CODER_REPOMAP_TOKENS`
 *    explicit override (including "0" to disable).
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
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { WorkspaceContext } from './workspace.js';

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
 * Accepts either a raw projectId (legacy callers) or a `WorkspaceContext`
 * (preferred — keeps the call site honest about which workspace it queries).
 *
 * Pass `budgetChars: 0` (returned by resolveRepoMapBudget for small
 * projects or when CODER_REPOMAP_TOKENS=0) to short-circuit and return
 * an empty string.
 */
export function buildRepoMap(
  db: CodeIndexDB,
  projectOrWorkspace: number | WorkspaceContext,
  budgetChars: number,
): string {
  if (budgetChars <= 0) return '';
  const projectId =
    typeof projectOrWorkspace === 'number' ? projectOrWorkspace : projectOrWorkspace.projectId;
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

/**
 * Pick a char budget for the repo map based on indexed file count.
 *
 * Priority:
 *   1. `CODER_REPOMAP_TOKENS` env override — any value (including "0" to
 *      disable) wins. Lets ops force a specific budget per deployment.
 *   2. Auto-sizing by indexed file count:
 *        <50    → 0     (grep is faster than the map's overhead)
 *        50–499 → 1500  (~375 tokens; pays for itself in 1 saved grep)
 *        500–1999 → 3000 (~750 tokens; covers medium repos comfortably)
 *        ≥2000  → 4500  (~1125 tokens; large repos benefit from headroom)
 *
 * Returns 0 when the project hasn't been indexed — without symbols there
 * is nothing useful to print.
 */
export function resolveRepoMapBudget(
  db: CodeIndexDB,
  projectId: number,
  isIndexed: boolean,
): number {
  if (!isIndexed) return 0;
  const override = process.env.CODER_REPOMAP_TOKENS;
  if (override !== undefined && override !== '') {
    const parsed = Number(override);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  }
  const fileCount = db.listFiles(projectId).length;
  if (fileCount < 50) return 0;
  if (fileCount < 500) return 1500;
  if (fileCount < 2000) return 3000;
  return 4500;
}
