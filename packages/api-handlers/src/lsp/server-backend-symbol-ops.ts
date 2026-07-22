import type {
  DocumentSymbolDTO,
  SignatureHelpDTO,
  WorkspaceEditDTO,
} from '@mcp/api-bus';
import type { CodeIndexDB } from '@mcp/store/db.js';
import { fromLsp, type LspRange0, type LspWorkspaceEdit } from '@mcp/services/lsp/lsp-protocol.js';
import {
  INTERACTIVE_LSP_ACQUIRE_DEADLINE_MS,
  type LspServerTarget,
} from './server-backend-acquire.js';
import { mapServerWorkspaceEdit } from './server-backend-mappers.js';
import { acquireWithDoc, debugLspOperation } from './server-backend-op-context.js';

export async function serverRename(
  db: CodeIndexDB,
  projectId: number,
  root: string,
  file: string,
  languageId: string,
  position: { line: number; column: number },
  newName: string,
  signal?: AbortSignal,
  serverTarget?: string | LspServerTarget,
): Promise<WorkspaceEditDTO | null> {
  const acquired = await acquireWithDoc(
    db,
    projectId,
    root,
    file,
    languageId,
    serverTarget,
    0,
    signal,
    'manual',
  );
  if (!acquired) return null;
  try {
    const raw = await acquired.acq.handle.rename(
      acquired.abs,
      position,
      newName,
      signal,
    ) as LspWorkspaceEdit | null;
    return mapServerWorkspaceEdit(raw ?? undefined) ?? { changes: {} };
  } catch (error) {
    debugLspOperation('serverRename', projectId, languageId, error, acquired.acq);
    return null;
  }
}

interface WireSignature {
  label?: string;
  documentation?: string | { value?: string };
  parameters?: Array<{
    label?: string | [number, number];
    documentation?: string | { value?: string };
  }>;
}

const docString = (doc?: string | { value?: string }): string | undefined =>
  typeof doc === 'string' ? doc : doc?.value;

export function mapServerSignatureHelp(raw: unknown): SignatureHelpDTO | null {
  const help = raw as {
    signatures?: WireSignature[];
    activeSignature?: number | null;
    activeParameter?: number | null;
  } | null;
  if (!help?.signatures?.length) return null;
  const signatures = help.signatures
    .filter((signature) => typeof signature.label === 'string' && signature.label.length > 0)
    .map((signature) => ({
      label: signature.label as string,
      documentation: docString(signature.documentation),
      parameters: (signature.parameters ?? []).map((parameter) => ({
        label: Array.isArray(parameter.label)
          ? (signature.label as string).slice(parameter.label[0], parameter.label[1])
          : (parameter.label ?? ''),
        documentation: docString(parameter.documentation),
      })),
    }));
  if (signatures.length === 0) return null;
  return {
    signatures,
    activeSignature: help.activeSignature ?? 0,
    activeParameter: help.activeParameter ?? 0,
  };
}

export async function serverSignatureHelp(
  db: CodeIndexDB,
  projectId: number,
  root: string,
  file: string,
  languageId: string,
  position: { line: number; column: number },
  signal?: AbortSignal,
  serverTarget?: string | LspServerTarget,
): Promise<SignatureHelpDTO | null> {
  const acquired = await acquireWithDoc(
    db,
    projectId,
    root,
    file,
    languageId,
    serverTarget,
    INTERACTIVE_LSP_ACQUIRE_DEADLINE_MS,
    signal,
    'interactive',
  );
  if (!acquired) return null;
  try {
    return mapServerSignatureHelp(
      await acquired.acq.handle.signatureHelp(acquired.abs, position, signal),
    );
  } catch (error) {
    debugLspOperation('serverSignatureHelp', projectId, languageId, error, acquired.acq);
    return null;
  }
}

const SYMBOL_KIND_NAMES = [
  'file', 'module', 'namespace', 'package', 'class', 'method', 'property',
  'field', 'constructor', 'enum', 'interface', 'function', 'variable',
  'constant', 'string', 'number', 'boolean', 'array', 'object', 'key',
  'null', 'enum-member', 'struct', 'event', 'operator', 'type-parameter',
] as const;

const symbolKindName = (kind: unknown): string => typeof kind === 'number' && kind >= 1 && kind <= 26
  ? SYMBOL_KIND_NAMES[kind - 1]
  : 'variable';

const symbolRange = (range?: LspRange0) => range
  ? { start: fromLsp(range.start), end: fromLsp(range.end) }
  : { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } };

interface WireDocSymbol {
  name?: string;
  detail?: string;
  kind?: number;
  range?: LspRange0;
  selectionRange?: LspRange0;
  children?: WireDocSymbol[];
  location?: { range?: LspRange0 };
  containerName?: string;
}

export function mapServerDocumentSymbols(raw: unknown): DocumentSymbolDTO[] {
  const items = Array.isArray(raw) ? raw as WireDocSymbol[] : [];
  if (items.length === 0) return [];
  if (items[0]?.range) {
    const convert = (symbol: WireDocSymbol): DocumentSymbolDTO => ({
      name: symbol.name ?? '?',
      detail: symbol.detail || undefined,
      kind: symbolKindName(symbol.kind),
      range: symbolRange(symbol.range),
      selectionRange: symbolRange(symbol.selectionRange ?? symbol.range),
      children: symbol.children?.length ? symbol.children.map(convert) : undefined,
    });
    return items.map(convert);
  }
  const roots: DocumentSymbolDTO[] = [];
  const byName = new Map<string, DocumentSymbolDTO>();
  for (const item of items) {
    const symbol: DocumentSymbolDTO = {
      name: item.name ?? '?',
      kind: symbolKindName(item.kind),
      range: symbolRange(item.location?.range),
      selectionRange: symbolRange(item.location?.range),
    };
    if (item.name) byName.set(item.name, symbol);
    const parent = item.containerName ? byName.get(item.containerName) : undefined;
    if (parent) (parent.children ??= []).push(symbol);
    else roots.push(symbol);
  }
  return roots;
}

export async function serverDocumentSymbols(
  db: CodeIndexDB,
  projectId: number,
  root: string,
  file: string,
  languageId: string,
  signal?: AbortSignal,
  serverTarget?: string | LspServerTarget,
): Promise<DocumentSymbolDTO[] | null> {
  const acquired = await acquireWithDoc(
    db,
    projectId,
    root,
    file,
    languageId,
    serverTarget,
    INTERACTIVE_LSP_ACQUIRE_DEADLINE_MS,
    signal,
    'background',
  );
  if (!acquired) return null;
  try {
    const mapped = mapServerDocumentSymbols(
      await acquired.acq.handle.documentSymbol(acquired.abs, signal),
    );
    return mapped.length > 0 ? mapped : null;
  } catch (error) {
    debugLspOperation('serverDocumentSymbols', projectId, languageId, error, acquired.acq);
    return null;
  }
}
