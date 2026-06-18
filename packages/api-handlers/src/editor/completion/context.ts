/**
 * Layered autocomplete context — THE single entry point the editor handler
 * calls instead of the old import-only buildImportContext. Assembles tiers
 * top-down (most relevant first), each clamped to its cap AND the remaining
 * budget, stopping when the budget is spent. Tiers that produce nothing cost
 * zero. Fail-open: any tier that throws degrades to "skipped", never an error.
 *
 *   T0 scope     — "Inside method X of class Y (returns Z)"
 *   T1 members   — the receiver at the cursor (LSP-first, index fallback)
 *   T2 siblings  — enclosing class members + same-file declarations
 *   T3 imports   — imported APIs with method catalogs
 */
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { DBSymbol } from '@mcp/shared/types.js';
import type { PromptWindows } from '../completion-prompt.js';
import { enclosingClass } from '../../lsp/fallback-members.js';
import { enclosingScopeLine } from './scope.js';
import { receiverMembers, type MemberSource } from './members.js';
import { classAndSiblingSymbols } from './siblings.js';
import { importedCatalogs } from './imports.js';

export interface LayeredContextInput {
  db: CodeIndexDB;
  projectId: number;
  file: string;
  language: string;
  windows: PromptWindows;
  position: { line: number; col: number };
  budgetChars: number;
  /**
   * 'layered' (default) = full tiers. 'imports_only' = just T3, reproducing
   * the pre-overhaul import context — the A/B baseline + kill-switch.
   */
  mode?: 'layered' | 'imports_only';
}

export interface LayeredContext {
  block: string;
  tiersUsed: string[];
  memberSource: MemberSource;
  /** A `::`/`->` member trigger was detected (even if it resolved to nothing). */
  memberTriggerHit: boolean;
  membersInjected: number;
  chars: number;
}

// Per-tier caps; the orchestrator also clamps to remaining budget.
const T1_CAP = 700;
const T2_CAP = 500;
const T3_CAP = 700;
/** Approx chars a "### Title\n\n" heading + separators add per section. */
const HEADING_OVERHEAD = 24;

export async function buildLayeredContext(input: LayeredContextInput): Promise<LayeredContext> {
  const { db, projectId, file, language, windows, position, budgetChars, mode = 'layered' } = input;
  const sections: Array<{ title: string; body: string }> = [];
  const tiersUsed: string[] = [];
  let remaining = budgetChars;
  let memberSource: MemberSource = 'none';
  let memberTriggerHit = false;
  let membersInjected = 0;

  const layered = mode !== 'imports_only';
  // Symbols/enclosing only feed T0/T1/T2 — skip the DB read on the imports_only
  // A/B cohort, which renders T3 alone.
  let syms: DBSymbol[] = [];
  let enclosing: string | null = null;
  if (layered) {
    try { syms = db.getSymbolsByFile(projectId, file); } catch { syms = []; }
    enclosing = enclosingClass(syms, position.line);
  }

  const take = (title: string, body: string, chars: number) => {
    sections.push({ title, body });
    remaining -= chars + HEADING_OVERHEAD;
    tiersUsed.push(title);
  };

  // T0 — scope (cheap, always first so it is never budget-starved).
  if (layered) {
    try {
      const scope = enclosingScopeLine(syms, position.line);
      if (scope) take('Scope', scope, scope.length);
    } catch { /* skip */ }
  }

  // T1 — receiver members at the cursor.
  if (layered && remaining > 0) {
    try {
      const lastPrefixLine = windows.prefix.slice(windows.prefix.lastIndexOf('\n') + 1);
      const mem = await receiverMembers({
        db, projectId, file, language, position, lastPrefixLine, syms,
        budgetChars: Math.min(T1_CAP, remaining),
      });
      memberSource = mem.source;
      memberTriggerHit = mem.triggered;
      if (mem.text) {
        membersInjected = mem.count;
        take(`Members of ${mem.label}`, mem.text, mem.chars);
      }
    } catch { /* skip */ }
  }

  // T2 — enclosing class members + same-file siblings.
  if (layered && remaining > 0) {
    try {
      const sib = classAndSiblingSymbols({
        db, projectId, syms, enclosingClassName: enclosing, budgetChars: Math.min(T2_CAP, remaining),
      });
      if (sib.text) take('Current class & file', sib.text, sib.chars);
    } catch { /* skip */ }
  }

  // T3 — imported APIs with method catalogs.
  if (remaining > 0) {
    try {
      const imp = importedCatalogs(db, projectId, file, Math.min(T3_CAP, remaining));
      if (imp.text) take('Imported APIs', imp.text, imp.chars);
    } catch { /* skip */ }
  }

  const block = sections.map((s) => `### ${s.title}\n${s.body}`).join('\n\n');
  return { block, tiersUsed, memberSource, memberTriggerHit, membersInjected, chars: block.length };
}
