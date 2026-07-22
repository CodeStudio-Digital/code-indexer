import { readFileSync } from 'node:fs';
import type { LspLocation, TextEditDTO } from '@mcp/api-bus';
import type { CodeIndexDB } from '@mcp/store/db.js';
import {
  fromLsp,
  type LspCodeAction,
  type LspTextEdit,
} from '@mcp/services/lsp/lsp-protocol.js';
import type { LspServerTarget } from './server-backend-acquire.js';
import {
  mapServerWorkspaceEdit,
  toLocations,
} from './server-backend-mappers.js';
import { acquireWithDoc, debugLspOperation } from './server-backend-op-context.js';
import { getDoc } from './document-store.js';

export function mapServerTextEdits(raw: unknown): TextEditDTO[] {
  const items = Array.isArray(raw) ? raw as LspTextEdit[] : [];
  return items
    .filter((edit) => edit && typeof edit.newText === 'string' && !!edit.range)
    .map((edit) => ({
      range: { start: fromLsp(edit.range.start), end: fromLsp(edit.range.end) },
      newText: edit.newText,
    }));
}

export async function serverFormatting(
  db: CodeIndexDB,
  projectId: number,
  root: string,
  file: string,
  languageId: string,
  options: { tabSize: number; insertSpaces: boolean },
  range?: { start: { line: number; column: number }; end: { line: number; column: number } },
  serverTarget?: string | LspServerTarget,
  signal?: AbortSignal,
): Promise<TextEditDTO[] | null> {
  const acquired = await acquireWithDoc(
    db,
    projectId,
    root,
    file,
    languageId,
    serverTarget,
    undefined,
    signal,
    'manual',
  );
  if (!acquired) return null;
  try {
    const raw = range
      ? await acquired.acq.handle.rangeFormatting(acquired.abs, range, options, signal)
      : await acquired.acq.handle.formatting(acquired.abs, options, signal);
    return mapServerTextEdits(raw);
  } catch (error) {
    debugLspOperation('serverFormatting', projectId, languageId, error, acquired.acq);
    return null;
  }
}

export type FlatEdit = {
  file: string;
  range: TextEditDTO['range'];
  newText: string;
};

export function pickOrganizeImportsEdits(raw: unknown): FlatEdit[] {
  const actions = Array.isArray(raw) ? raw as LspCodeAction[] : [];
  for (const action of actions) {
    if (!action || typeof action !== 'object') continue;
    if (!action.kind?.startsWith('source.organizeImports')) continue;
    const mapped = mapServerWorkspaceEdit(action.edit);
    if (!mapped) continue;
    return Object.entries(mapped.changes).flatMap(([file, edits]) =>
      edits.map((edit) => ({ file, range: edit.range, newText: edit.newText })),
    );
  }
  return [];
}

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

export async function serverOrganizeImports(
  db: CodeIndexDB,
  projectId: number,
  root: string,
  file: string,
  languageId: string,
  signal?: AbortSignal,
): Promise<FlatEdit[] | null> {
  const acquired = await acquireWithDoc(
    db,
    projectId,
    root,
    file,
    languageId,
    undefined,
    undefined,
    signal,
    'manual',
  );
  if (!acquired) return null;
  let content = getDoc(projectId, file)?.content;
  if (content === undefined) {
    try {
      content = readFileSync(acquired.abs, 'utf-8');
    } catch {
      content = '';
    }
  }
  try {
    const raw = await acquired.acq.handle.codeActions(
      acquired.abs,
      fullDocRange(content),
      ['source.organizeImports'],
      { origin: 'invoke', signal },
    );
    return pickOrganizeImportsEdits(raw);
  } catch (error) {
    debugLspOperation('serverOrganizeImports', projectId, languageId, error, acquired.acq);
    return null;
  }
}

export async function serverImplementation(
  db: CodeIndexDB,
  projectId: number,
  root: string,
  file: string,
  languageId: string,
  position: { line: number; column: number },
  signal?: AbortSignal,
  serverTarget?: string | LspServerTarget,
): Promise<LspLocation[] | null> {
  const acquired = await acquireWithDoc(
    db,
    projectId,
    root,
    file,
    languageId,
    serverTarget,
    undefined,
    signal,
    'manual',
  );
  if (!acquired) return null;
  try {
    return toLocations(
      await acquired.acq.handle.implementation(acquired.abs, position, signal),
    );
  } catch (error) {
    debugLspOperation('serverImplementation', projectId, languageId, error, acquired.acq);
    return null;
  }
}
