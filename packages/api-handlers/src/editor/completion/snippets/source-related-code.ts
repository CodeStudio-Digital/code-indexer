import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { getDoc } from '../../../lsp/document-store.js';
import { approxTokens, type ContextSnippet, type EngineInput } from './types.js';

const IGNORED_PATH_RE = /(^|\/)(node_modules|vendor|dist|build|coverage|\.git|\.next|generated)(\/|$)/i;
const IDENT_RE = /[$A-Za-z_\x80-\uFFFF][$\w\x80-\uFFFF]{2,}/g;
const STOP = new Set(['class', 'const', 'else', 'false', 'function', 'import', 'namespace', 'null', 'private', 'protected', 'public', 'return', 'static', 'this', 'true', 'use', 'var', 'while']);

function identifiersNear(prefix: string): string[] {
  const tail = prefix.split('\n').slice(-24).join('\n');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of tail.matchAll(IDENT_RE)) {
    const value = match[0]!.replace(/^\$/, '');
    if (value.length < 3 || STOP.has(value.toLowerCase()) || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out.slice(-8).reverse();
}

function ftsTerm(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function sameLanguage(candidate: string, current: string): boolean {
  return extname(candidate).toLowerCase() === extname(current).toLowerCase();
}

async function contentFor(input: EngineInput, path: string): Promise<string | null> {
  const live = getDoc(input.projectId, path);
  if (live) return live.content;
  const root = input.db.getProject(input.projectId)?.root_path;
  if (!root) return null;
  const rootAbs = resolve(root);
  const absolute = resolve(rootAbs, path);
  const rootPrefix = rootAbs.endsWith(sep) ? rootAbs : `${rootAbs}${sep}`;
  if (!absolute.toLowerCase().startsWith(rootPrefix.toLowerCase())) return null;
  return readFile(absolute, 'utf8').catch(() => null);
}

function bestWindow(content: string, ids: string[]): string {
  const lines = content.split('\n');
  let bestLine = 0;
  let best = -1;
  for (let i = 0; i < lines.length; i++) {
    const score = ids.reduce((n, id) => n + (lines[i]!.includes(id) ? 1 : 0), 0);
    if (score > best) { best = score; bestLine = i; }
  }
  const start = Math.max(0, bestLine - 8);
  return lines.slice(start, Math.min(lines.length, start + 22)).join('\n').trim();
}

/** FTS-backed cross-file examples. Called only after explicit consent. */
export async function relatedCodeSnippets(input: EngineInput): Promise<ContextSnippet[]> {
  const ids = identifiersNear(input.windows.prefix);
  if (ids.length === 0) return [];
  const query = ids.slice(0, 5).map(ftsTerm).join(' OR ');
  const matches = input.db.searchFileContents(input.projectId, query, 12);
  const out: ContextSnippet[] = [];
  let used = 0;
  const cap = input.relatedCodeTokens ?? 700;
  for (const match of matches) {
    const path = match.path.replace(/\\/g, '/');
    if (path === input.file.replace(/\\/g, '/') || IGNORED_PATH_RE.test(path) || !sameLanguage(path, input.file)) continue;
    const meta = input.db.getFile(input.projectId, match.path);
    if (!meta || meta.is_generated) continue;
    const content = await contentFor(input, match.path);
    if (!content) continue;
    let window = bestWindow(content, ids);
    let tokens = approxTokens(window);
    const remaining = cap - used;
    if (remaining <= 0) break;
    if (tokens > remaining) {
      window = window.slice(0, Math.max(0, remaining * 3));
      tokens = approxTokens(window);
    }
    if (!window || tokens <= 0) continue;
    out.push({
      kind: 'related-code', filePath: match.path, content: window,
      score: Math.max(0, Math.min(1, 1 / (1 + Math.abs(match.rank)))),
      tokens, volatile: false,
    });
    used += tokens;
    if (out.length >= 3) break;
  }
  return out;
}

export const __relatedCodeTest = { identifiersNear, bestWindow };
