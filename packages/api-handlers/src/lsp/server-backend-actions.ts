import type { CodeActionDTO, WorkspaceEditDTO } from '@mcp/api-bus';
import type { CodeIndexDB } from '@mcp/store/db.js';
import { relToAbsCanonical as relToAbs } from '@mcp/shared/utils/fs-canonical.js';
import type { LspWorkspaceEdit } from '@mcp/services/lsp/lsp-protocol.js';
import {
  acquireLspWithDeadline,
  type LspServerTarget,
} from './server-backend-acquire.js';
import { ensureLspManager } from './server-backend-manager.js';
import {
  mapServerCodeActions,
  mapServerWorkspaceEdit,
} from './server-backend-mappers.js';
import { getDoc } from './document-store.js';

const configuredDeadline = Number(process.env.MCP_LSP_CODEACTION_DEADLINE_MS);
const CODEACTION_DEADLINE_MS = Number.isFinite(configuredDeadline) ? configuredDeadline : 600;

export async function serverCodeActions(
  db: CodeIndexDB,
  projectId: number,
  root: string,
  file: string,
  languageId: string,
  range: { start: { line: number; column: number }; end: { line: number; column: number } },
  origin: 'auto' | 'invoke' = 'invoke',
  signal?: AbortSignal,
  serverTarget?: string | LspServerTarget,
): Promise<CodeActionDTO[] | null> {
  const automaticController = origin === 'auto' ? new AbortController() : null;
  const forwardAbort = automaticController && signal
    ? () => automaticController.abort(signal.reason)
    : undefined;
  if (forwardAbort) signal!.addEventListener('abort', forwardAbort, { once: true });
  if (automaticController && signal?.aborted) automaticController.abort(signal.reason);
  const budget = automaticController ? setTimeout(() => automaticController.abort(), 750) : undefined;
  budget?.unref?.();
  const requestSignal = automaticController?.signal ?? signal;
  try {
    const acquired = await acquireLspWithDeadline(
      db,
      projectId,
      languageId,
      CODEACTION_DEADLINE_MS,
      requestSignal,
      origin === 'auto' ? 'background' : 'manual',
      serverTarget,
    );
    if (!acquired) return null;
    const abs = relToAbs(root, file);
    const liveDoc = getDoc(projectId, file);
    if (liveDoc) {
      acquired.handle.ensureOpen(abs, liveDoc.languageId, liveDoc.version, liveDoc.content);
    }
    return mapServerCodeActions(
      await acquired.handle.codeActions(
        abs,
        range,
        undefined,
        { origin, signal: requestSignal },
      ),
      acquired.def.id,
      acquired.routeId,
    );
  } catch {
    return null;
  } finally {
    if (budget) clearTimeout(budget);
    if (forwardAbort) signal!.removeEventListener('abort', forwardAbort);
  }
}

export async function serverResolveCodeAction(
  db: CodeIndexDB,
  projectId: number,
  action: CodeActionDTO,
  signal?: AbortSignal,
): Promise<CodeActionDTO | null> {
  if (!action.originServerId || !action.raw || !action.needsResolve) return action;
  const manager = ensureLspManager(db);
  const acquired = action.originRouteId
    ? await manager.acquireByRouteId(projectId, action.originRouteId, 'manual')
    : await manager.acquireById(projectId, action.originServerId, 'manual');
  if (!acquired?.handle.supportsCodeActionResolve()) return action;
  try {
    const resolved = await acquired.handle.resolveCodeAction(action.raw, signal);
    return mapServerCodeActions([resolved], acquired.def.id, acquired.routeId)[0] ?? null;
  } catch {
    return null;
  }
}

export async function serverExecuteCodeAction(
  db: CodeIndexDB,
  projectId: number,
  action: CodeActionDTO,
): Promise<{ ok: true; edit?: WorkspaceEditDTO }> {
  const command = action.command;
  if (!action.originServerId || !command?.command || command.command.length > 256) {
    throw new Error('invalid LSP command');
  }
  if (JSON.stringify(command.arguments ?? []).length > 64_000) {
    throw new Error('LSP command arguments too large');
  }
  const manager = ensureLspManager(db);
  const acquired = action.originRouteId
    ? await manager.acquireByRouteId(projectId, action.originRouteId, 'manual')
    : await manager.acquireById(projectId, action.originServerId, 'manual');
  if (!acquired) throw new Error('origin LSP server unavailable');
  const executed = await acquired.handle.executeCommand(command.command, command.arguments);
  const changes: WorkspaceEditDTO['changes'] = {};
  for (const rawEdit of executed.workspaceEdits) {
    const mapped = mapServerWorkspaceEdit(rawEdit as LspWorkspaceEdit);
    for (const [file, edits] of Object.entries(mapped?.changes ?? {})) {
      changes[file] = [...(changes[file] ?? []), ...edits];
    }
  }
  const edit = Object.keys(changes).length > 0 ? { changes } : undefined;
  return { ok: true, edit };
}
