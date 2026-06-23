/**
 * Pure rendering + budget helpers for the layered autocomplete context.
 * No DB, no IO — string work only, so every tier renderer stays testable
 * without a provider or an index (same spirit as completion-prompt.ts).
 */
import type { DBSymbol } from '@mcp/shared/types.js';

const MAX_LINE = 160;

function clip(line: string, max = MAX_LINE): string {
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/**
 * One-line signature for a symbol (moved here from completion-context.ts).
 * Falls back to "<kind> <name>" when the extractor stored no signature.
 */
export function signatureLine(s: DBSymbol): string {
  const sig = (s.signature ?? '').trim();
  return sig.length > 0 ? clip(sig) : `${s.kind} ${s.name}`;
}

/**
 * Compact member line for the receiver tier: `name(params): ret` for
 * callables, bare `name` (or `name: type`) otherwise. Prefers the structured
 * parameters/return_type columns, falling back to the raw signature.
 */
export function memberLine(s: DBSymbol): string {
  const callable = s.kind === 'method' || s.kind === 'function';
  if (!callable) {
    const ret = (s.return_type ?? '').trim();
    return clip(ret ? `${s.name}: ${ret}` : s.name, 120);
  }
  const params = (s.parameters ?? '').trim().replace(/^\(|\)$/g, '');
  const ret = (s.return_type ?? '').trim();
  const sig = (s.signature ?? '').trim();
  if (!params && !ret && sig) return clip(sig, 120);
  return clip(`${s.name}(${params})${ret ? `: ${ret}` : ''}`, 120);
}

/**
 * Accumulate `lines` until adding the next would exceed `cap` chars (newline
 * included). Strict priority-ordered accumulator — stops at budget, never
 * "gather all then truncate". Returns the joined text + chars consumed.
 */
export function clampToBudget(lines: string[], cap: number): { text: string; chars: number } {
  if (cap <= 0) return { text: '', chars: 0 };
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    const add = line.length + 1; // trailing newline
    if (used + add > cap) break;
    out.push(line);
    used += add;
  }
  return { text: out.join('\n'), chars: used };
}
