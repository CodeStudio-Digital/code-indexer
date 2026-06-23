/**
 * T2 — the current class's members + the file's other top-level symbols.
 * This is what makes "complete a call to a sibling method" work: the model
 * sees the methods/properties it can reach from where the cursor sits.
 */
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { DBSymbol } from '@mcp/shared/types.js';
import { signatureLine, clampToBudget } from './render.js';

export interface SiblingInput {
  db: CodeIndexDB;
  projectId: number;
  syms: DBSymbol[];
  enclosingClassName: string | null;
  budgetChars: number;
}

/**
 * Render the enclosing class's members first (highest-signal siblings), then
 * the file's other top-level declarations (functions, other classes). Empty
 * string when nothing fits or the file has no symbols.
 */
export function classAndSiblingSymbols(input: SiblingInput): { text: string; chars: number } {
  const { db, projectId, syms, enclosingClassName, budgetChars } = input;
  if (budgetChars <= 0) return { text: '', chars: 0 };

  const lines: string[] = [];
  const seen = new Set<string>();
  const add = (line: string) => {
    if (!line || seen.has(line)) return;
    seen.add(line);
    lines.push(line);
  };

  if (enclosingClassName) {
    for (const m of db.getClassMembers(enclosingClassName, projectId)) add(signatureLine(m));
  }
  // Other top-level declarations in the same file (skip members, already
  // covered above for the enclosing class).
  for (const s of syms) {
    if (s.parent) continue;
    if (enclosingClassName && s.name === enclosingClassName) continue;
    add(signatureLine(s));
  }

  return clampToBudget(lines, budgetChars);
}
