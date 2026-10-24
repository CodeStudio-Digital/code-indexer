/** Bounded structural context appended after the static prompt cache prefix.
 * Recent files and their top-level symbols are paged in SQL. */
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { WorkspaceContext } from './workspace.js';

const MAX_FILES = 80;




/** A zero character budget disables the optional prompt addendum. */
export function buildRepoMap(
  db: CodeIndexDB,
  projectOrWorkspace: number | WorkspaceContext,
  budgetChars: number,
): string {
  if (budgetChars <= 0) return '';
  const projectId =
    typeof projectOrWorkspace === 'number' ? projectOrWorkspace : projectOrWorkspace.projectId;
  const page = db.listAgentRepoMap(projectId, { order: 'recent', limit: MAX_FILES });
  if (!page.total) return '';
  const ordered = page.items;

  const lines: string[] = [];
  let used = 0;
  let elidedFiles = 0;
  for (const f of ordered) {
    if (used >= budgetChars) {
      elidedFiles++;
      continue;
    }
    const top = f.symbols
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
  const more = page.total > ordered.length ? `\n[${page.total - ordered.length} further indexed files; use get_repo_map pages.]` : '';
  return `# Repo map (top-level symbols, recent files first)\n${lines.join('\n')}${trailer}${more}\n`;
}

/** Current fixed prompt policy; the old environment budget knob is retired. */
export function resolveRepoMapBudget(
  db: CodeIndexDB,
  projectId: number,
  isIndexed: boolean,
): number {
  if (!isIndexed) return 0;
  void db;
  void projectId;
  return 1_024;
}
