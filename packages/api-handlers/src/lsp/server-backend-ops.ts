/**
 * Editor-grade ops backed by real LSP servers — the second wave of
 * server-backend.ts: rename, signature help and document symbols
 * (serverFormatting lands in a later wave).
 *
 * Same conventions as server-backend.ts: acquire the server that owns the
 * language, `ensureOpen` the live buffer BEFORE the request (W3 — the
 * server answers nothing for a doc it doesn't know), and translate the LSP
 * wire shape into this app's 1-based DTOs. `null` = no server could answer
 * (the router decides the fallback; rename deliberately has none).
 */
import { readFileSync } from 'node:fs';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { DocumentSymbolDTO, LspLocation, SignatureHelpDTO, TextEditDTO, WorkspaceEditDTO } from '@mcp/api-bus';
import { relToAbsCanonical as relToAbs } from '@mcp/shared/utils/fs-canonical.js';
import {
  fromLsp,
  type LspCodeAction,
  type LspRange0,
  type LspTextEdit,
  type LspWorkspaceEdit,
} from '@mcp/services/lsp/lsp-protocol.js';
import { getDoc } from './document-store.js';
import { ensureLspManager, mapServerWorkspaceEdit, toLocations } from './server-backend.js';

/**
 * `textDocument/rename` via the language server owning `languageId`.
 *
 * Returns:
 *   - `WorkspaceEditDTO` (1-based ranges, absolute paths) when the server
 *     answered; `{ changes: {} }` means "server answered: nothing to edit".
 *   - `null` when no server is available or the request failed — the
 *     router surfaces a friendly error to the editor.
 */
type Acquired = NonNullable<Awaited<ReturnType<ReturnType<typeof ensureLspManager>['acquire']>>>;

/** Shared acquire + live-buffer sync preamble for every op below. */
async function acquireWithDoc(
  db: CodeIndexDB,
  projectId: number,
  root: string,
  file: string,
  languageId: string,
  serverId?: string,
): Promise<{ acq: Acquired; abs: string } | null> {
  const manager = ensureLspManager(db);
  const acq = serverId ? await manager.acquireById(projectId, serverId) : await manager.acquire(projectId, languageId);
  if (!acq) return null;
  const abs = relToAbs(root, file);
  const live = getDoc(projectId, file);
  if (live) acq.handle.ensureOpen(abs, live.languageId, live.version, live.content);
  return { acq, abs };
}

function debugLog(op: string, projectId: number, languageId: string, err: unknown, acq?: Acquired): void {
  if (process.env.MCP_LSP_DEBUG !== '1') return;
  const tail = acq?.handle.stderrTail?.slice(-200) ?? '';
  console.error(
    `[lsp.${op}] proj=${projectId} ${languageId} threw: ` +
    `${err instanceof Error ? err.message : String(err)}${tail ? ` — stderr: ${tail}` : ''}`,
  );
}

export async function serverRename(
  db: CodeIndexDB,
  projectId: number,
  root: string,
  file: string,
  languageId: string,
  position: { line: number; column: number },
  newName: string,
): Promise<WorkspaceEditDTO | null> {
  const acq = await ensureLspManager(db).acquire(projectId, languageId);
  if (!acq) return null;
  const abs = relToAbs(root, file);
  // Mirror serverCompletion (W3): guarantee the live buffer is open on the
  // server before the request — rename over a stale/unknown doc is garbage.
  const live = getDoc(projectId, file);
  if (live) acq.handle.ensureOpen(abs, live.languageId, live.version, live.content);
  try {
    const raw = (await acq.handle.rename(abs, position, newName)) as LspWorkspaceEdit | null;
    return mapServerWorkspaceEdit(raw ?? undefined) ?? { changes: {} };
  } catch (err) {
    debugLog('serverRename', projectId, languageId, err, acq);
    return null;
  }
}

// ── Signature help ───────────────────────────────────────────────────────

interface WireSignature {
  label?: string;
  documentation?: string | { value?: string };
  parameters?: Array<{ label?: string | [number, number]; documentation?: string | { value?: string } }>;
}

const docString = (d?: string | { value?: string }): string | undefined =>
  typeof d === 'string' ? d : d?.value;

/** Pure LSP→DTO mapper (exported for tests). Offset-pair param labels become substrings. */
export function mapServerSignatureHelp(raw: unknown): SignatureHelpDTO | null {
  const help = raw as { signatures?: WireSignature[]; activeSignature?: number | null; activeParameter?: number | null } | null;
  if (!help || !Array.isArray(help.signatures) || help.signatures.length === 0) return null;
  const signatures = help.signatures
    .filter((s) => typeof s.label === 'string' && s.label.length > 0)
    .map((s) => ({
      label: s.label as string,
      documentation: docString(s.documentation),
      parameters: (s.parameters ?? []).map((p) => ({
        label: Array.isArray(p.label)
          ? (s.label as string).slice(p.label[0], p.label[1])
          : (p.label ?? ''),
        documentation: docString(p.documentation),
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
): Promise<SignatureHelpDTO | null> {
  const got = await acquireWithDoc(db, projectId, root, file, languageId);
  if (!got) return null;
  try {
    return mapServerSignatureHelp(await got.acq.handle.signatureHelp(got.abs, position));
  } catch (err) {
    debugLog('serverSignatureHelp', projectId, languageId, err, got.acq);
    return null;
  }
}

// ── Document symbols ─────────────────────────────────────────────────────

/** LSP numeric SymbolKind (1-26) → the DTO's lowercase string kinds. */
const SYMBOL_KIND_NAMES = [
  'file', 'module', 'namespace', 'package', 'class', 'method', 'property',
  'field', 'constructor', 'enum', 'interface', 'function', 'variable',
  'constant', 'string', 'number', 'boolean', 'array', 'object', 'key',
  'null', 'enum-member', 'struct', 'event', 'operator', 'type-parameter',
] as const;

const kindName = (k: unknown): string =>
  typeof k === 'number' && k >= 1 && k <= 26 ? SYMBOL_KIND_NAMES[k - 1] : 'variable';

const dtoRange = (r?: LspRange0) => r
  ? { start: fromLsp(r.start), end: fromLsp(r.end) }
  : { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } };

interface WireDocSymbol {
  name?: string; detail?: string; kind?: number;
  range?: LspRange0; selectionRange?: LspRange0;
  children?: WireDocSymbol[];
  location?: { range?: LspRange0 };
  containerName?: string;
}

/**
 * Pure LSP→DTO mapper (exported for tests). Accepts BOTH wire shapes:
 * hierarchical `DocumentSymbol[]` (has `range`) and flat
 * `SymbolInformation[]` (has `location`) — the flat shape is promoted to a
 * shallow hierarchy by `containerName`.
 */
export function mapServerDocumentSymbols(raw: unknown): DocumentSymbolDTO[] {
  const items = Array.isArray(raw) ? (raw as WireDocSymbol[]) : [];
  if (items.length === 0) return [];

  if (items[0]?.range) {
    const convert = (n: WireDocSymbol): DocumentSymbolDTO => ({
      name: n.name ?? '?',
      detail: n.detail || undefined,
      kind: kindName(n.kind),
      range: dtoRange(n.range),
      selectionRange: dtoRange(n.selectionRange ?? n.range),
      children: n.children?.length ? n.children.map(convert) : undefined,
    });
    return items.map(convert);
  }

  // Flat SymbolInformation[] — group children under their container by name.
  const toDto = (n: WireDocSymbol): DocumentSymbolDTO => ({
    name: n.name ?? '?',
    kind: kindName(n.kind),
    range: dtoRange(n.location?.range),
    selectionRange: dtoRange(n.location?.range),
  });
  const roots: DocumentSymbolDTO[] = [];
  const byName = new Map<string, DocumentSymbolDTO>();
  for (const item of items) {
    const dto = toDto(item);
    if (item.name) byName.set(item.name, dto);
    const parent = item.containerName ? byName.get(item.containerName) : undefined;
    if (parent) (parent.children ??= []).push(dto);
    else roots.push(dto);
  }
  return roots;
}

export async function serverDocumentSymbols(
  db: CodeIndexDB,
  projectId: number,
  root: string,
  file: string,
  languageId: string,
): Promise<DocumentSymbolDTO[] | null> {
  const got = await acquireWithDoc(db, projectId, root, file, languageId);
  if (!got) return null;
  try {
    const mapped = mapServerDocumentSymbols(await got.acq.handle.documentSymbol(got.abs));
    return mapped.length > 0 ? mapped : null; // empty → let the router fall back to the index
  } catch (err) {
    debugLog('serverDocumentSymbols', projectId, languageId, err, got.acq);
    return null;
  }
}

// ── Formatting ───────────────────────────────────────────────────────────

/** Pure LSP TextEdit[]→DTO mapper (exported for tests). 0-based → 1-based. */
export function mapServerTextEdits(raw: unknown): TextEditDTO[] {
  const items = Array.isArray(raw) ? (raw as LspTextEdit[]) : [];
  return items
    .filter((e) => e && typeof e.newText === 'string' && !!e.range)
    .map((e) => ({
      range: { start: fromLsp(e.range.start), end: fromLsp(e.range.end) },
      newText: e.newText,
    }));
}

/**
 * `textDocument/formatting` (whole doc) or `textDocument/rangeFormatting`
 * (when `range` is present) via the server owning `languageId`. `null` = no
 * server / request failed — the router raises a friendly error (there is no
 * fallback formatter on purpose).
 */
export async function serverFormatting(
  db: CodeIndexDB,
  projectId: number,
  root: string,
  file: string,
  languageId: string,
  options: { tabSize: number; insertSpaces: boolean },
  range?: { start: { line: number; column: number }; end: { line: number; column: number } },
  serverId?: string,
): Promise<TextEditDTO[] | null> {
  const got = await acquireWithDoc(db, projectId, root, file, languageId, serverId);
  if (!got) return null;
  try {
    const raw = range
      ? await got.acq.handle.rangeFormatting(got.abs, range, options)
      : await got.acq.handle.formatting(got.abs, options);
    return mapServerTextEdits(raw);
  } catch (err) {
    debugLog('serverFormatting', projectId, languageId, err, got.acq);
    return null;
  }
}

// ── Organize imports ─────────────────────────────────────────────────────

type FlatEdit = { file: string; range: TextEditDTO['range']; newText: string };

/**
 * Pure picker (exported for tests): first codeAction with kind
 * `source.organizeImports*` AND an edit → flat edits (absolute paths,
 * 1-based). `[]` = the server answered but offers no such action
 * (Intelephense free) — the router reports `applied: false`.
 */
export function pickOrganizeImportsEdits(raw: unknown): FlatEdit[] {
  const actions = Array.isArray(raw) ? (raw as LspCodeAction[]) : [];
  for (const action of actions) {
    if (!action || typeof action !== 'object') continue;
    if (!action.kind?.startsWith('source.organizeImports')) continue;
    const mapped = mapServerWorkspaceEdit(action.edit);
    if (!mapped) continue;
    return Object.entries(mapped.changes).flatMap(([f, edits]) =>
      edits.map((e) => ({ file: f, range: e.range, newText: e.newText })),
    );
  }
  return [];
}

/** Full-document 1-based range for a codeAction request (source actions). */
function fullDocRange(content: string): {
  start: { line: number; column: number };
  end: { line: number; column: number };
} {
  const lines = content.split('\n');
  return {
    start: { line: 1, column: 1 },
    end: { line: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1 },
  };
}

/**
 * Organize imports via codeAction `only: ['source.organizeImports']`.
 * Pyright supports it; Intelephense free does not (→ `[]`). `null` = no
 * server / request failed.
 */
export async function serverOrganizeImports(
  db: CodeIndexDB,
  projectId: number,
  root: string,
  file: string,
  languageId: string,
): Promise<FlatEdit[] | null> {
  const got = await acquireWithDoc(db, projectId, root, file, languageId);
  if (!got) return null;
  let content = getDoc(projectId, file)?.content;
  if (content === undefined) {
    try { content = readFileSync(got.abs, 'utf-8'); } catch { content = ''; }
  }
  try {
    const raw = await got.acq.handle.codeActions(got.abs, fullDocRange(content), ['source.organizeImports']);
    return pickOrganizeImportsEdits(raw);
  } catch (err) {
    debugLog('serverOrganizeImports', projectId, languageId, err, got.acq);
    return null;
  }
}

// ── Go to implementation ─────────────────────────────────────────────────

/** `textDocument/implementation`. `null` = no server / failed; `[]` = server
 *  answered nothing (the router then tries the structural-index fallback). */
export async function serverImplementation(
  db: CodeIndexDB,
  projectId: number,
  root: string,
  file: string,
  languageId: string,
  position: { line: number; column: number },
): Promise<LspLocation[] | null> {
  const got = await acquireWithDoc(db, projectId, root, file, languageId);
  if (!got) return null;
  try {
    return toLocations(await got.acq.handle.implementation(got.abs, position));
  } catch (err) {
    debugLog('serverImplementation', projectId, languageId, err, got.acq);
    return null;
  }
}
