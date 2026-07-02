/**
 * Index health report — sanity queries over a LIVE project index ("valide
 * toda a indexação"). Read-only; cheap aggregates only. Consumed by
 * scripts/index-health.ts (CLI) and available to an admin panel later.
 */
import type { DB } from './types.js';

export interface LanguageCoverage {
  language: string;
  files: number;
  filesWithSymbols: number;
  symbols: number;
  /** % of symbols carrying a namespace (only meaningful for namespaced languages). */
  namespaceCoverage: number;
}

export interface IndexHealthReport {
  files: number;
  symbols: number;
  references: number;
  /** References whose symbol_id could not be resolved to an indexed symbol. */
  danglingReferences: number;
  danglingReferencePct: number;
  /** Internal file_dependencies whose target file is not in the index. */
  unresolvedInternalDeps: number;
  relations: { extends: number; implements: number; mixes: number };
  perLanguage: LanguageCoverage[];
  /** Extractable files with zero symbols — parse-error suspects. */
  suspectFiles: Array<{ path: string; language: string; line_count: number | null }>;
}

const EXTRACTABLE = new Set([
  'typescript', 'tsx', 'javascript', 'python', 'go', 'rust', 'java', 'csharp',
  'kotlin', 'ruby', 'cpp', 'c', 'php', 'swift', 'css', 'html', 'vue',
]);

const NAMESPACED = new Set(['php', 'python', 'go', 'java', 'csharp', 'kotlin', 'rust']);

export function indexHealth(db: DB, projectId: number): IndexHealthReport {
  const one = (sql: string, ...p: unknown[]) =>
    (db.prepare(sql).get(...p) as { n: number }).n;

  const files = one('SELECT COUNT(*) n FROM files WHERE project_id = ?', projectId);
  const symbols = one('SELECT COUNT(*) n FROM symbols WHERE project_id = ?', projectId);
  const references = one('SELECT COUNT(*) n FROM symbol_references WHERE project_id = ?', projectId);
  const danglingReferences = one(
    'SELECT COUNT(*) n FROM symbol_references WHERE project_id = ? AND symbol_id IS NULL', projectId);
  const unresolvedInternalDeps = one(
    "SELECT COUNT(*) n FROM file_dependencies WHERE project_id = ? AND dep_type = 'internal' AND target_file_id IS NULL",
    projectId);

  const relRows = db.prepare(
    'SELECT relation_type t, COUNT(*) n FROM symbol_relations WHERE project_id = ? GROUP BY relation_type'
  ).all(projectId) as Array<{ t: string; n: number }>;
  const relations = { extends: 0, implements: 0, mixes: 0 };
  for (const r of relRows) if (r.t in relations) relations[r.t as keyof typeof relations] = r.n;

  const langRows = db.prepare(`
    SELECT f.language language,
           COUNT(DISTINCT f.id) files,
           COUNT(DISTINCT s.file_id) filesWithSymbols,
           COUNT(s.id) symbols,
           SUM(CASE WHEN s.namespace IS NOT NULL THEN 1 ELSE 0 END) withNs
    FROM files f LEFT JOIN symbols s ON s.file_id = f.id
    WHERE f.project_id = ?
    GROUP BY f.language ORDER BY files DESC
  `).all(projectId) as Array<{ language: string | null; files: number; filesWithSymbols: number; symbols: number; withNs: number | null }>;

  const perLanguage: LanguageCoverage[] = langRows
    .filter((r) => r.language && EXTRACTABLE.has(r.language))
    .map((r) => ({
      language: r.language as string,
      files: r.files,
      filesWithSymbols: r.filesWithSymbols,
      symbols: r.symbols,
      namespaceCoverage: NAMESPACED.has(r.language as string) && r.symbols > 0
        ? Math.round(((r.withNs ?? 0) / r.symbols) * 100)
        : 0,
    }));

  const suspectFiles = db.prepare(`
    SELECT f.path, f.language, f.line_count
    FROM files f LEFT JOIN symbols s ON s.file_id = f.id
    WHERE f.project_id = ? AND s.id IS NULL AND f.language IN (${[...EXTRACTABLE].map(() => '?').join(',')})
      AND COALESCE(f.line_count, 0) > 5
    GROUP BY f.id ORDER BY f.line_count DESC LIMIT 10
  `).all(projectId, ...EXTRACTABLE) as Array<{ path: string; language: string; line_count: number | null }>;

  return {
    files, symbols, references, danglingReferences,
    danglingReferencePct: references > 0 ? Math.round((danglingReferences / references) * 1000) / 10 : 0,
    unresolvedInternalDeps, relations, perLanguage, suspectFiles,
  };
}
