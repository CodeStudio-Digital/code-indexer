/**
 * T3 — imported APIs WITH their method catalogs. Supersedes the old
 * buildImportContext, which listed only the class line. Two resolution paths:
 *  - dependency resolved to a file → its exported top-level symbols;
 *  - dependency unresolved (the common PHP `use App\Models\X` case where
 *    namespace→file mapping failed) → resolve the import's short name across
 *    the project index (findSymbolsByName), so receiver classes still surface.
 * For container symbols (class/interface/…) a few member names are appended.
 */
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { DBSymbol, DBFileDependency } from '@mcp/shared/types.js';
import { signatureLine, clampToBudget } from './render.js';

const MAX_IMPORTS = 6;
const MAX_SYMBOLS_PER_FILE = 8;
const MAX_MEMBERS_PER_CLASS = 6;
const CONTAINER = new Set(['class', 'interface', 'enum', 'trait', 'struct']);

function memberCatalog(db: CodeIndexDB, projectId: number, s: DBSymbol): string {
  if (!CONTAINER.has(s.kind)) return signatureLine(s);
  const names = db
    .getClassMembers(s.name, projectId)
    .slice(0, MAX_MEMBERS_PER_CLASS)
    .map((m) => `${m.name}()`)
    .join(' ');
  return names ? `${signatureLine(s)} { ${names} }` : signatureLine(s);
}

function depLines(
  db: CodeIndexDB, projectId: number, file: string, d: DBFileDependency,
): string[] {
  let header: string;
  let symbols: DBSymbol[];
  if (d.target_file_path && d.target_file_path !== file) {
    header = `// ${d.target_file_path}`;
    symbols = db.getSymbolsByFile(projectId, d.target_file_path).filter((s) => s.exported === 1 && !s.parent);
  } else {
    // Unresolved import (typical for PHP use-statements) → resolve by short name.
    const short = (d.import_path || '').split(/[\\/]/).pop() || '';
    if (!short) return [];
    symbols = db.findSymbolsByName(projectId, short, { limit: 3 }).filter((s) => !s.parent);
    if (symbols.length === 0) return [];
    header = `// ${d.import_path}`;
  }
  if (symbols.length === 0) return [];
  const out = [header];
  for (const s of symbols.slice(0, MAX_SYMBOLS_PER_FILE)) out.push(memberCatalog(db, projectId, s));
  return out;
}

/** Render imported APIs for `file`, capped at `budgetChars`. */
export function importedCatalogs(
  db: CodeIndexDB, projectId: number, file: string, budgetChars: number,
): { text: string; chars: number } {
  if (budgetChars <= 0) return { text: '', chars: 0 };
  let fileRow;
  try { fileRow = db.getFile(projectId, file); } catch { return { text: '', chars: 0 }; }
  if (!fileRow) return { text: '', chars: 0 };

  let deps: DBFileDependency[];
  try { deps = db.getDependencies(fileRow.id, projectId); } catch { return { text: '', chars: 0 }; }

  const lines: string[] = [];
  let count = 0;
  for (const d of deps) {
    if (count >= MAX_IMPORTS) break;
    const section = depLines(db, projectId, file, d);
    if (section.length <= 1) continue; // header only → nothing useful
    if (lines.length > 0) lines.push('');
    lines.push(...section);
    count++;
  }
  return clampToBudget(lines, budgetChars);
}
