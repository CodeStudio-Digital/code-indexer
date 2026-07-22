import type {
  CodeActionDTO,
  LspLocation,
  TextEditDTO,
  WorkspaceEditDTO,
} from '@mcp/api-bus';
import {
  fromLsp,
  uriToPath,
  type LspCodeAction,
  type LspLocationLike,
  type LspRange0,
  type LspTextDocumentEdit,
  type LspTextEdit,
  type LspWorkspaceEdit,
} from '@mcp/services/lsp/lsp-protocol.js';
import type { LspServerDef } from '@mcp/services/lsp/server-registry.js';

export function rangeFrom(r?: LspRange0): {
  start: { line: number; column: number };
  end: { line: number; column: number };
} {
  return r
    ? { start: fromLsp(r.start), end: fromLsp(r.end) }
    : { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } };
}

function textEditFrom(edit: LspTextEdit): TextEditDTO {
  return { range: rangeFrom(edit.range), newText: edit.newText };
}

function isTextDocumentEdit(entry: unknown): entry is LspTextDocumentEdit {
  if (!entry || typeof entry !== 'object') return false;
  const record = entry as Record<string, unknown>;
  const textDocument = record.textDocument as Record<string, unknown> | undefined;
  return !!textDocument && typeof textDocument.uri === 'string' && Array.isArray(record.edits);
}

export function serverInfo(def: LspServerDef) {
  return {
    id: def.id,
    familyId: def.familyId,
    profileId: def.profileId,
    label: def.label,
    version: def.install.version,
    sizeLabel: def.sizeLabel,
    supportTier: def.supportTier,
  };
}

export function mapServerWorkspaceEdit(
  edit: LspWorkspaceEdit | undefined,
): WorkspaceEditDTO | undefined {
  if (!edit) return undefined;
  const changes: Record<string, TextEditDTO[]> = {};
  const push = (uri: string, edits: LspTextEdit[]): void => {
    if (!uri.toLowerCase().startsWith('file:')) return;
    const file = uriToPath(uri);
    const mapped = edits.map(textEditFrom);
    if (mapped.length > 0) changes[file] = [...(changes[file] ?? []), ...mapped];
  };

  for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
    if (Array.isArray(edits)) push(uri, edits);
  }
  for (const entry of edit.documentChanges ?? []) {
    if (isTextDocumentEdit(entry)) push(entry.textDocument.uri, entry.edits);
  }

  return Object.keys(changes).length > 0 ? { changes } : undefined;
}

export function mapServerCodeActions(
  raw: unknown,
  originServerId?: string,
  originRouteId?: string,
): CodeActionDTO[] {
  const entries = Array.isArray(raw) ? raw : [];
  const actions: CodeActionDTO[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const action = entry as LspCodeAction;
    if (typeof action.title !== 'string' || !action.title.trim() || action.disabled) continue;
    const edit = mapServerWorkspaceEdit(action.edit);
    const direct = entry as { command?: unknown; arguments?: unknown[] };
    const command = typeof direct.command === 'string'
      ? { command: direct.command, arguments: direct.arguments }
      : action.command?.command
        ? { command: action.command.command, arguments: action.command.arguments }
        : undefined;
    if (!edit && !command && action.data === undefined) continue;
    actions.push({
      title: action.title,
      kind: action.kind ?? 'quickfix',
      isPreferred: action.isPreferred || undefined,
      edit,
      command,
      originServerId,
      originRouteId,
      raw: action,
      needsResolve: !edit && !command && action.data !== undefined,
    });
  }
  return actions;
}

export function toLocations(raw: unknown): LspLocation[] {
  const locations: LspLocationLike[] = !raw
    ? []
    : Array.isArray(raw)
      ? raw as LspLocationLike[]
      : [raw as LspLocationLike];
  return locations
    .map((location) => {
      const uri = location.targetUri ?? location.uri;
      if (!uri || !uri.toLowerCase().startsWith('file:')) return null;
      return {
        file: uriToPath(uri),
        range: rangeFrom(location.targetSelectionRange ?? location.range),
      };
    })
    .filter((location): location is LspLocation => !!location);
}
