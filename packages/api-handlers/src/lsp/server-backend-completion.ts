import type { CompletionItem, LspCompletionList } from '@mcp/api-bus';
import type { CodeIndexDB } from '@mcp/store/db.js';
import { relToAbsCanonical as relToAbs } from '@mcp/shared/utils/fs-canonical.js';
import {
  mapCompletionKind,
  type LspCompletionItem,
} from '@mcp/services/lsp/lsp-protocol.js';
import {
  acquireLspWithDeadline,
  INTERACTIVE_LSP_ACQUIRE_DEADLINE_MS,
  type LspServerTarget,
} from './server-backend-acquire.js';
import { rangeFrom } from './server-backend-mappers.js';
import { getDoc } from './document-store.js';

const COMPLETION_RAW_KIND = 'mcp-lsp-completion';
const MAX_SERVER_COMPLETIONS = 500;

export interface ServerCompletionRaw {
  kind: typeof COMPLETION_RAW_KIND;
  serverId: string;
  routeId?: string;
  item: LspCompletionItem;
}

export function isServerCompletionRaw(value: unknown): value is ServerCompletionRaw {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Partial<ServerCompletionRaw>;
  return raw.kind === COMPLETION_RAW_KIND
    && typeof raw.serverId === 'string'
    && (raw.routeId === undefined || typeof raw.routeId === 'string')
    && !!raw.item
    && typeof raw.item === 'object';
}

/** Pure LSP→contract item mapper. All ranges become 1-based. */
export function mapServerCompletionItem(
  item: LspCompletionItem,
  originServerId?: string,
  originRouteId?: string,
): CompletionItem {
  const textEdit = item.textEdit;
  const editRange = textEdit?.replace ?? textEdit?.range ?? textEdit?.insert;
  let labelDetails = item.labelDetails;
  let detail = item.detail;
  if (!labelDetails && detail && !item.label.includes('[')) {
    const fqn = /^use\s+(.+)$/.exec(detail.trim())?.[1];
    if (fqn?.includes('\\')) {
      labelDetails = { description: fqn.slice(0, fqn.lastIndexOf('\\')) };
      detail = undefined;
    }
  }
  return {
    label: item.label,
    kind: mapCompletionKind(item.kind),
    detail,
    documentation: typeof item.documentation === 'object'
      ? item.documentation?.value
      : item.documentation,
    insertText: textEdit?.newText ?? item.insertText ?? item.label,
    additionalTextEdits: item.additionalTextEdits?.map((edit) => ({
      range: rangeFrom(edit.range),
      newText: edit.newText,
    })),
    sortText: item.sortText,
    filterText: item.filterText,
    insertTextFormat: item.insertTextFormat,
    preselect: item.preselect,
    labelDetails,
    commitCharacters: item.commitCharacters,
    textEdit: editRange
      ? { range: rangeFrom(editRange), newText: textEdit?.newText ?? item.label }
      : undefined,
    insertReplaceEdit: textEdit?.insert && textEdit.replace
      ? {
          insert: rangeFrom(textEdit.insert),
          replace: rangeFrom(textEdit.replace),
          newText: textEdit.newText,
        }
      : undefined,
    deprecated: item.deprecated,
    tags: item.tags,
    origin: 'lsp',
    raw: originServerId
      ? {
          kind: COMPLETION_RAW_KIND,
          serverId: originServerId,
          routeId: originRouteId,
          item,
        } satisfies ServerCompletionRaw
      : item,
  };
}

function localCompletionPrefix(
  content: string,
  position: { line: number; column: number },
): string {
  const line = content.split(/\r?\n/, position.line)[position.line - 1] ?? '';
  const beforeCursor = line.slice(0, Math.max(0, position.column - 1));
  return beforeCursor.match(/[$\p{L}\p{N}_]+$/u)?.[0] ?? '';
}

/** Filter before truncation while retaining the language server's exact ranking. */
export function filterServerCompletionItems(
  items: LspCompletionItem[],
  content: string,
  position: { line: number; column: number },
): { items: LspCompletionItem[]; truncated: boolean } {
  const rawPrefix = localCompletionPrefix(content, position).toLocaleLowerCase();
  const prefix = rawPrefix.replace(/^\$/, '');
  const filtered = prefix
    ? items.filter((item) => {
        const candidate = (item.filterText ?? item.label).toLocaleLowerCase();
        return candidate.startsWith(rawPrefix) || candidate.replace(/^\$/, '').startsWith(prefix);
      })
    : items;
  return {
    items: filtered.slice(0, MAX_SERVER_COMPLETIONS),
    truncated: filtered.length > MAX_SERVER_COMPLETIONS,
  };
}

export async function serverCompletion(
  db: CodeIndexDB,
  projectId: number,
  root: string,
  file: string,
  languageId: string,
  position: { line: number; column: number },
  context?: { triggerKind: number; triggerCharacter?: string },
  signal?: AbortSignal,
  serverTarget?: string | LspServerTarget,
): Promise<LspCompletionList | null> {
  const acquired = await acquireLspWithDeadline(
    db,
    projectId,
    languageId,
    INTERACTIVE_LSP_ACQUIRE_DEADLINE_MS,
    signal,
    'interactive',
    serverTarget,
  );
  if (!acquired) return null;
  const abs = relToAbs(root, file);
  const liveDoc = getDoc(projectId, file);
  if (liveDoc) {
    acquired.handle.ensureOpen(abs, liveDoc.languageId, liveDoc.version, liveDoc.content);
  }
  try {
    const raw = await acquired.handle.completion(abs, position, context, signal);
    const items: LspCompletionItem[] = Array.isArray(raw)
      ? raw as LspCompletionItem[]
      : ((raw as { items?: LspCompletionItem[] })?.items ?? []);
    const selected = filterServerCompletionItems(items, liveDoc?.content ?? '', position);
    return {
      items: selected.items.map((item) => mapServerCompletionItem(
        item,
        acquired.def.id,
        acquired.routeId,
      )),
      isIncomplete: selected.truncated
        || (!Array.isArray(raw) && (raw as { isIncomplete?: boolean })?.isIncomplete === true),
    };
  } catch (error) {
    if (process.env.MCP_LSP_DEBUG === '1') {
      const tail = acquired.handle.stderrTail?.slice(-200) ?? '';
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[lsp.serverCompletion] proj=${projectId} ${languageId} threw: ${message}`
        + `${tail ? ` — stderr: ${tail}` : ''}`,
      );
    }
    return null;
  }
}

export async function serverResolveCompletion(
  db: CodeIndexDB,
  projectId: number,
  languageId: string,
  item: unknown,
  signal?: AbortSignal,
): Promise<CompletionItem | null> {
  if (!item || typeof item !== 'object') return null;
  const origin = isServerCompletionRaw(item) ? item : null;
  const acquired = await acquireLspWithDeadline(
    db,
    projectId,
    languageId,
    0,
    signal,
    'manual',
    origin ? { serverId: origin.serverId, routeId: origin.routeId } : undefined,
  );
  if (!acquired) return null;
  try {
    const resolved = await acquired.handle.resolveCompletion(origin?.item ?? item, signal);
    if (!resolved || typeof resolved !== 'object') return null;
    return mapServerCompletionItem(
      resolved as LspCompletionItem,
      acquired.def.id,
      acquired.routeId,
    );
  } catch {
    return null;
  }
}
