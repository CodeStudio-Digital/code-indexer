/**
 * Snippet adapters over the v1 tier modules (scope/siblings/imports/members)
 * — the index-backed sources of Context Engine v2. Pure translation: the tier
 * modules keep their char-based budgets; caps arrive in tokens and convert.
 */
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { DBSymbol } from '@mcp/shared/types.js';
import { enclosingScopeLine } from '../scope.js';
import { classAndSiblingSymbols } from '../siblings.js';
import { importedCatalogs } from '../imports.js';
import { receiverMembers, type ReceiverMembersResult } from '../members.js';
import {
  approxTokens,
  type ContextSnippet,
  type EngineInput,
  MEMBERS_CAP_TOK,
  SCOPE_CAP_TOK,
  SIBLINGS_CAP_TOK,
  IMPORTS_CAP_TOK,
} from './types.js';

const tokToChars = (tok: number): number => Math.floor(tok * 3.5);

/** Path + language header — ~free and always first (Copilot's PathMarker). */
export function markerSnippet(file: string, language: string): ContextSnippet {
  const content = `Path: ${file}\nLanguage: ${language}`;
  return { kind: 'marker', filePath: '', content, score: 1, tokens: approxTokens(content), volatile: false };
}

/** T0 — "Inside method x() of class Y" scope line (volatile: cursor-bound). */
export function scopeSnippet(syms: DBSymbol[], line: number): ContextSnippet | null {
  const scope = enclosingScopeLine(syms, line);
  if (!scope) return null;
  const clipped = scope.slice(0, tokToChars(SCOPE_CAP_TOK));
  return { kind: 'scope', filePath: '', content: clipped, score: 1, tokens: approxTokens(clipped), volatile: true };
}

export interface MemberSnippetResult {
  snippet: ContextSnippet | null;
  raw: ReceiverMembersResult;
}

/** T1 — receiver members at the cursor (volatile: refreshes per keystroke). */
export async function memberSnippets(
  input: EngineInput,
  syms: DBSymbol[],
  docContent: string | undefined,
): Promise<MemberSnippetResult> {
  const lastPrefixLine = input.windows.prefix.slice(input.windows.prefix.lastIndexOf('\n') + 1);
  const raw = await receiverMembers({
    db: input.db,
    projectId: input.projectId,
    file: input.file,
    language: input.language,
    position: input.position,
    lastPrefixLine,
    syms,
    budgetChars: tokToChars(MEMBERS_CAP_TOK),
    docContent,
    lspRaceMs: input.lspMemberRaceMs,
  });
  if (!raw.text) return { snippet: null, raw };
  const content = `Members of ${raw.label}:\n${raw.text}`;
  return {
    snippet: { kind: 'members', filePath: '', content, score: 1, tokens: approxTokens(content), volatile: true },
    raw,
  };
}

/** T2 — enclosing class members + same-file top-level declarations. */
export function siblingSnippets(
  db: CodeIndexDB,
  projectId: number,
  syms: DBSymbol[],
  enclosing: string | null,
  file: string,
): ContextSnippet[] {
  const sib = classAndSiblingSymbols({
    db, projectId, syms, enclosingClassName: enclosing, budgetChars: tokToChars(SIBLINGS_CAP_TOK),
  });
  if (!sib.text) return [];
  return [{
    kind: 'siblings', filePath: file, content: sib.text, score: 1, tokens: approxTokens(sib.text), volatile: false,
  }];
}

/** T3 — imported APIs with method catalogs. */
export function importSnippets(db: CodeIndexDB, projectId: number, file: string): ContextSnippet[] {
  const imp = importedCatalogs(db, projectId, file, tokToChars(IMPORTS_CAP_TOK));
  if (!imp.text) return [];
  return [{
    kind: 'imports', filePath: file, content: imp.text, score: 1, tokens: approxTokens(imp.text), volatile: false,
  }];
}
