import type { DBFile, DBSymbol, HybridSearchResult } from '@mcp/shared/types.js';

function compactStructuralText(value: string | null | undefined, max = 220): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Build a subtitle only from deterministic structural fields. The retired
 * per-file LLM summary/concepts columns must never leak back into search, even
 * while old database rows still contain them during migration.
 */
export function structuralResultPreview(result: HybridSearchResult): string {
  if (result.type === 'symbol') {
    const symbol = result.data as DBSymbol;
    const signature = compactStructuralText(symbol.signature);
    const comment = compactStructuralText(symbol.comment);
    if (signature && comment) return `${signature}\n${comment}`;
    if (signature || comment) return signature || comment;
    return [symbol.kind, symbol.namespace ?? symbol.parent]
      .filter((part): part is string => Boolean(part))
      .join(' · ');
  }

  const file = result.data as DBFile;
  return [file.language, `${file.line_count} lines`].filter(Boolean).join(' · ');
}
