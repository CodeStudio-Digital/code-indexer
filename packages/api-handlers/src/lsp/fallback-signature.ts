/**
 * Signature help from the STRUCTURAL INDEX — the offline floor when no
 * language server owns the file (or the server has nothing to say).
 * `symbols.parameters` (tree-sitter) is the data source; the call site is
 * located by a backward scan for the innermost unclosed `(`.
 */
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { SignatureHelpDTO } from '@mcp/api-bus';

const CALLABLE_KINDS = new Set(['function', 'method', 'constructor']);
const MAX_SCAN_LINES = 3;

/** Blank out string literals so quotes/commas inside them don't confuse the scan. */
function stripStrings(line: string): string {
  return line.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, (m) => ' '.repeat(m.length));
}

export interface CallContext {
  name: string;
  activeParameter: number;
}

/**
 * Pure backward scan (exported for tests): find the identifier owning the
 * innermost unclosed `(` before `position`, counting top-level commas for
 * activeParameter. `lines` is the WHOLE file; position is 1-based.
 */
export function computeCallContext(lines: string[], position: { line: number; column: number }): CallContext | null {
  let depth = 0;
  let commas = 0;
  const startLine = position.line - 1;
  const endLine = Math.max(0, startLine - MAX_SCAN_LINES);
  for (let li = startLine; li >= endLine; li--) {
    const raw = lines[li] ?? '';
    const text = stripStrings(raw);
    const from = li === startLine ? Math.min(position.column - 2, text.length - 1) : text.length - 1;
    for (let i = from; i >= 0; i--) {
      const ch = text[i];
      if (ch === ')' || ch === ']') depth++;
      else if (ch === ',' && depth === 0) commas++;
      else if (ch === '[' && depth > 0) depth--;
      else if (ch === '(') {
        if (depth > 0) { depth--; continue; }
        // Innermost unclosed paren — the identifier ends right before it.
        const head = text.slice(0, i);
        const m = /([A-Za-z_$][A-Za-z0-9_$]*)\s*$/.exec(head);
        if (!m) return null;
        return { name: m[1], activeParameter: commas };
      }
    }
  }
  return null;
}

/** Split a `parameters` string on TOP-LEVEL commas (nesting and quoted defaults kept whole). */
export function splitParams(params: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (const ch of params) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '\'' || ch === '"') {
      quote = ch;
    } else if ('([<{'.includes(ch)) depth++;
    else if (')]>}'.includes(ch)) depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function fallbackSignatureHelp(
  db: CodeIndexDB,
  projectId: number,
  content: string,
  position: { line: number; column: number },
): SignatureHelpDTO | null {
  const call = computeCallContext(content.split('\n'), position);
  if (!call) return null;
  const candidates = db.findSymbolsByName(projectId, call.name)
    .filter((s) => CALLABLE_KINDS.has(s.kind) && s.parameters !== null);
  const sym = candidates[0];
  if (!sym) return null;
  const params = splitParams(sym.parameters ?? '');
  const label = `${call.name}(${params.join(', ')})${sym.return_type ? `: ${sym.return_type}` : ''}`;
  return {
    signatures: [{
      label,
      parameters: params.map((p) => ({ label: p })),
      documentation: sym.comment ?? undefined,
    }],
    activeSignature: 0,
    activeParameter: Math.min(call.activeParameter, Math.max(0, params.length - 1)),
  };
}
