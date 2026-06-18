/**
 * T0 — the enclosing-scope line: "Inside method X of class Y (returns Z)".
 * Tells the model exactly where the cursor lives so completions respect the
 * current method/class instead of guessing. Pure over the file's symbols.
 */
import type { DBSymbol } from '@mcp/shared/types.js';
import { enclosingClass } from '../../lsp/fallback-members.js';

const CALLABLE = new Set(['method', 'function']);

/** Innermost callable whose [line, end_line] brackets `line`. */
function enclosingCallable(symbols: DBSymbol[], line: number): DBSymbol | null {
  let best: DBSymbol | null = null;
  for (const s of symbols) {
    if (!CALLABLE.has(s.kind)) continue;
    const start = s.line ?? 0;
    if (start > line) continue;
    const end = s.end_line ?? Number.MAX_SAFE_INTEGER;
    if (line > end) continue;
    if (!best || start > (best.line ?? 0)) best = s;
  }
  return best;
}

/**
 * Render the scope line for the cursor at `line`, or '' when neither a class
 * nor a callable brackets it (top-level code). The return type is appended
 * only when the extractor captured it.
 */
export function enclosingScopeLine(symbols: DBSymbol[], line: number): string {
  const cls = enclosingClass(symbols, line);
  const fn = enclosingCallable(symbols, line);
  if (!cls && !fn) return '';
  const ret = (fn?.return_type ?? '').trim();
  const retPart = ret ? ` (returns ${ret})` : '';
  if (fn && cls) return `Inside method ${fn.name}() of class ${cls}${retPart}.`;
  if (fn) return `Inside function ${fn.name}()${retPart}.`;
  return `Inside class ${cls}.`;
}
