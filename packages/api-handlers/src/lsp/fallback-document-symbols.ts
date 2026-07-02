/**
 * Document symbols from the STRUCTURAL INDEX — the offline floor for the
 * outline/breadcrumbs/sticky-scroll when no server owns the file. Hierarchy
 * is rebuilt from `symbols.parent` (immediate container name).
 */
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { DocumentSymbolDTO } from '@mcp/api-bus';
import type { DBSymbol } from '@mcp/shared/types.js';

function toDto(s: DBSymbol): DocumentSymbolDTO {
  const start = { line: s.line ?? 1, column: s.col ?? 1 };
  const end = { line: s.end_line ?? s.line ?? 1, column: 1 };
  const selEnd = { line: s.line ?? 1, column: (s.col ?? 1) + s.name.length };
  return {
    name: s.name,
    detail: s.signature && s.signature !== s.name ? s.signature : undefined,
    kind: s.kind,
    range: { start, end },
    selectionRange: { start, end: selEnd },
  };
}

export function fallbackDocumentSymbols(
  db: CodeIndexDB,
  projectId: number,
  file: string,
): DocumentSymbolDTO[] {
  const syms = db.getSymbolsByFile(projectId, file);
  if (syms.length === 0) return [];

  const roots: DocumentSymbolDTO[] = [];
  // Containers indexed by name — parent linkage in the index is name-based.
  const containers = new Map<string, DocumentSymbolDTO>();
  const dtos = syms.map((s) => {
    const dto = toDto(s);
    if (!containers.has(s.name)) containers.set(s.name, dto);
    return { dto, parent: s.parent };
  });
  for (const { dto, parent } of dtos) {
    const container = parent ? containers.get(parent) : undefined;
    if (container && container !== dto) (container.children ??= []).push(dto);
    else roots.push(dto);
  }
  return roots;
}
