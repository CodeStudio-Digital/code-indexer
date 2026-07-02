/**
 * LSP-definitions source — Continue's importDefinitionSnippets analogue: for
 * identifiers near the cursor, fetch their definitions from a WARM language
 * server and excerpt the defining code. Precise types the index can't give
 * (vendor classes, inferred generics), gated hard: warm server only, all
 * requests share one race box, per-ident results cached 30s.
 */
import { readFile } from 'node:fs/promises';
import type { DBSymbol } from '@mcp/shared/types.js';
import { ensureLspManager, serverDefinition } from '../../../lsp/server-backend.js';
import { getDoc } from '../../../lsp/document-store.js';
import { TtlLru } from '../../completion-context.js';
import { approxTokens, LSPDEF_CAP_TOK, type ContextSnippet, type EngineInput } from './types.js';

const MAX_IDENTS = 4;
const IDENT_LINES = 3;
const EXCERPT_LINES = 15;
const FILE_READ_BOX_MS = 80;

const KEYWORDS = new Set([
  'function', 'return', 'public', 'private', 'protected', 'static', 'const', 'class', 'interface',
  'new', 'this', 'self', 'parent', 'echo', 'print', 'array', 'string', 'else', 'elseif', 'foreach',
  'while', 'switch', 'case', 'break', 'continue', 'null', 'true', 'false', 'import', 'from', 'export',
  'async', 'await', 'let', 'var', 'void', 'use', 'namespace', 'extends', 'implements', 'throw', 'try',
  'catch', 'finally', 'default', 'typeof', 'instanceof', 'def', 'None', 'True', 'False', 'and', 'not',
]);

// requestId per (project:file:ident) → snippet (null = resolved to nothing).
const defCache = new TtlLru<ContextSnippet | null>(64, 30_000);

interface IdentAt { name: string; line: number; col: number }

/** Identifiers on the last few prefix lines, position-tagged, deduped. */
export function nearCursorIdents(prefix: string, cursorLine: number): IdentAt[] {
  const lines = prefix.split('\n');
  const lastLines = lines.slice(-IDENT_LINES);
  const baseLine = cursorLine - lastLines.length + 1;
  const seen = new Set<string>();
  const out: IdentAt[] = [];
  for (let i = lastLines.length - 1; i >= 0; i--) { // nearest line first
    const re = /[A-Za-z_][A-Za-z0-9_]*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lastLines[i]!))) {
      const name = m[0]!;
      if (name.length < 3 || KEYWORDS.has(name) || seen.has(name)) continue;
      // Uppercase-initial (types) or camelCase call targets carry the signal;
      // skip all-lowercase short locals to keep the request count tiny.
      if (!/[A-Z]/.test(name) && name.length < 6) continue;
      seen.add(name);
      out.push({ name, line: baseLine + i, col: m.index + 1 });
      if (out.length >= MAX_IDENTS) return out;
    }
  }
  return out;
}

function toRelative(abs: string, root: string): string | null {
  const a = abs.replace(/\\/g, '/');
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!a.toLowerCase().startsWith(`${r.toLowerCase()}/`)) return null;
  return a.slice(r.length + 1);
}

async function readTarget(projectId: number, rel: string, root: string): Promise<string | null> {
  const doc = getDoc(projectId, rel);
  if (doc) return doc.content;
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const SENTINEL = Symbol('read-timeout');
    const raced = await Promise.race([
      readFile(`${root.replace(/[\\/]+$/, '')}/${rel}`, 'utf8'),
      new Promise<typeof SENTINEL>((r) => { timer = setTimeout(() => r(SENTINEL), FILE_READ_BOX_MS); }),
    ]);
    if (timer) clearTimeout(timer);
    return raced === SENTINEL ? null : (raced as string);
  } catch {
    return null;
  }
}

function excerptAt(content: string, defLine: number, syms: DBSymbol[]): string {
  const lines = content.split('\n');
  const sym = syms.find((s) => (s.line ?? 0) <= defLine && defLine <= (s.end_line ?? defLine));
  const start = Math.max(0, (sym?.line ?? defLine) - 1);
  const end = Math.min(lines.length, Math.min(start + EXCERPT_LINES, (sym?.end_line ?? defLine + EXCERPT_LINES)));
  return lines.slice(start, end).join('\n').trimEnd();
}

export async function lspDefSnippets(input: EngineInput): Promise<ContextSnippet[]> {
  const { db, projectId, file, language, windows, position } = input;
  let ready = false;
  try { ready = ensureLspManager(db).status(projectId, language).state === 'ready'; } catch { ready = false; }
  if (!ready) return [];
  const root = db.getProject(projectId)?.root_path;
  if (!root) return [];

  const idents = nearCursorIdents(windows.prefix, position.line);
  if (idents.length === 0) return [];

  const results = await Promise.all(idents.map(async (ident): Promise<ContextSnippet | null> => {
    const cacheKey = `${projectId}:${file}:${ident.name}`;
    const cached = defCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const locs = await serverDefinition(
      db, projectId, root, file, language, { line: ident.line, column: ident.col },
    ).catch(() => null);
    const loc = locs?.[0];
    if (!loc) { defCache.set(cacheKey, null); return null; }
    const rel = toRelative(loc.file, root);
    // Defs inside the current file are already in (or near) the prompt window.
    if (!rel || rel === file) { defCache.set(cacheKey, null); return null; }
    const content = await readTarget(projectId, rel, root);
    if (!content) { defCache.set(cacheKey, null); return null; }
    let syms: DBSymbol[] = [];
    try { syms = db.getSymbolsByFile(projectId, rel); } catch { syms = []; }
    const excerpt = excerptAt(content, loc.range.start.line, syms);
    if (!excerpt) { defCache.set(cacheKey, null); return null; }
    const snippet: ContextSnippet = {
      kind: 'lsp-def', filePath: rel, content: excerpt, score: 1, tokens: approxTokens(excerpt), volatile: false,
    };
    defCache.set(cacheKey, snippet);
    return snippet;
  }));

  const out: ContextSnippet[] = [];
  const seenFiles = new Set<string>();
  let used = 0;
  for (const s of results) {
    if (!s || seenFiles.has(s.filePath)) continue;
    if (used + s.tokens > LSPDEF_CAP_TOK) continue;
    seenFiles.add(s.filePath);
    out.push(s);
    used += s.tokens;
  }
  return out;
}
