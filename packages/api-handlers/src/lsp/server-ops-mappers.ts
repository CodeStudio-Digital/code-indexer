/**
 * Pure LSP→DTO mappers for the editor ops served by real language servers
 * (signature help / document symbols). Split out of server-backend-ops.ts so
 * they stay unit-testable without sqlite and the ops file stays small.
 *
 * Wire quirks handled here:
 *  - SignatureHelp parameter labels come as a STRING (Pyright) or a
 *    [start,end] OFFSET pair into the signature label (Intelephense) —
 *    offsets are converted to the substring so the DTO is always a string.
 *  - documentSymbol answers either DocumentSymbol[] (hierarchical, has
 *    `range`) or SymbolInformation[] (flat, has `location`); the flat shape
 *    is promoted to a shallow hierarchy by grouping on `containerName`.
 */
import type { DocumentSymbolDTO, SignatureHelpDTO } from '@mcp/api-bus';
import {
  fromLsp,
  type LspDocumentSymbol,
  type LspRange0,
  type LspSignatureHelp,
  type LspSymbolInformation,
} from '@mcp/services/lsp/lsp-protocol.js';

/** LSP SymbolKind (1-based numeric) → this app's lowercase string kinds. */
const SYMBOL_KIND_NAMES: Record<number, string> = {
  1: 'file', 2: 'module', 3: 'namespace', 4: 'package', 5: 'class',
  6: 'method', 7: 'property', 8: 'field', 9: 'constructor', 10: 'enum',
  11: 'interface', 12: 'function', 13: 'variable', 14: 'constant',
  15: 'string', 16: 'number', 17: 'boolean', 18: 'array', 19: 'object',
  20: 'key', 21: 'null', 22: 'enum member', 23: 'struct', 24: 'event',
  25: 'operator', 26: 'type parameter',
};

export function symbolKindName(kind?: number): string {
  return SYMBOL_KIND_NAMES[kind ?? 0] ?? 'variable';
}

const docString = (d?: string | { value: string }): string | undefined =>
  typeof d === 'object' ? d?.value : d || undefined;

/** Null = server answered nothing / empty — the router tries the fallback. */
export function mapServerSignatureHelp(raw: unknown): SignatureHelpDTO | null {
  if (!raw || typeof raw !== 'object') return null;
  const help = raw as LspSignatureHelp;
  const sigs = Array.isArray(help.signatures) ? help.signatures : [];
  const signatures = sigs
    .filter((s) => s && typeof s.label === 'string')
    .map((s) => ({
      label: s.label,
      documentation: docString(s.documentation),
      parameters: (Array.isArray(s.parameters) ? s.parameters : []).map((p) => ({
        // [start,end] offsets index into the SIGNATURE label (LSP spec).
        label: Array.isArray(p.label) ? s.label.slice(p.label[0], p.label[1]) : String(p.label),
        documentation: docString(p.documentation),
      })),
    }));
  if (signatures.length === 0) return null;
  const clamp = (n: unknown): number =>
    typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0;
  return {
    signatures,
    activeSignature: Math.min(clamp(help.activeSignature), signatures.length - 1),
    activeParameter: clamp(help.activeParameter),
  };
}

const zeroRange = { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } };

function rangeFrom(r?: LspRange0): DocumentSymbolDTO['range'] {
  return r ? { start: fromLsp(r.start), end: fromLsp(r.end) } : zeroRange;
}

function fromDocumentSymbol(s: LspDocumentSymbol): DocumentSymbolDTO {
  const range = rangeFrom(s.range);
  const children = (Array.isArray(s.children) ? s.children : [])
    .filter((c) => c && typeof c.name === 'string')
    .map(fromDocumentSymbol);
  return {
    name: s.name,
    detail: s.detail || undefined,
    kind: symbolKindName(s.kind),
    range,
    selectionRange: s.selectionRange ? rangeFrom(s.selectionRange) : range,
    children: children.length > 0 ? children : undefined,
  };
}

/** Flat SymbolInformation[] → shallow hierarchy grouped by containerName. */
function fromSymbolInformation(items: LspSymbolInformation[]): DocumentSymbolDTO[] {
  const dtos = items.map((s) => {
    const range = rangeFrom(s.location?.range);
    return {
      dto: {
        name: s.name,
        kind: symbolKindName(s.kind),
        range,
        selectionRange: range,
      } as DocumentSymbolDTO,
      container: s.containerName || undefined,
    };
  });
  // First symbol with a given name wins as the container target.
  const byName = new Map<string, DocumentSymbolDTO>();
  for (const { dto } of dtos) if (!byName.has(dto.name)) byName.set(dto.name, dto);
  const roots: DocumentSymbolDTO[] = [];
  for (const { dto, container } of dtos) {
    const parent = container ? byName.get(container) : undefined;
    if (parent && parent !== dto) (parent.children ??= []).push(dto);
    else roots.push(dto);
  }
  return roots;
}

/** Accepts BOTH documentSymbol wire shapes; detects by `range` on the item. */
export function mapServerDocumentSymbols(raw: unknown): DocumentSymbolDTO[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const items = raw.filter(
    (s): s is Record<string, unknown> =>
      !!s && typeof s === 'object' && typeof (s as { name?: unknown }).name === 'string',
  );
  if (items.length === 0) return [];
  const hierarchical = 'range' in items[0];
  return hierarchical
    ? (items as unknown as LspDocumentSymbol[]).map(fromDocumentSymbol)
    : fromSymbolInformation(items as unknown as LspSymbolInformation[]);
}
