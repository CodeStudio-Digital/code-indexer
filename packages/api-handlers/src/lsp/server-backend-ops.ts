/**
 * Editor-grade ops backed by real LSP servers — the second wave of
 * server-backend.ts. Hosts the ops the editor's refactor surfaces call:
 * rename today; serverSignatureHelp / serverDocumentSymbols /
 * serverFormatting land here in a later wave.
 *
 * Same conventions as server-backend.ts: acquire the server that owns the
 * language, `ensureOpen` the live buffer BEFORE the request (W3 — the
 * server answers nothing for a doc it doesn't know), and translate the LSP
 * wire shape into this app's 1-based DTOs via `mapServerWorkspaceEdit`.
 * `null` = no server could answer (there is NO index fallback for rename —
 * the structural index is name-based and unsafe for it).
 */
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { WorkspaceEditDTO } from '@mcp/api-bus';
import { relToAbsCanonical as relToAbs } from '@mcp/shared/utils/fs-canonical.js';
import type { LspWorkspaceEdit } from '@mcp/services/lsp/lsp-protocol.js';
import { getDoc } from './document-store.js';
import { ensureLspManager, mapServerWorkspaceEdit } from './server-backend.js';

/**
 * `textDocument/rename` via the language server owning `languageId`.
 *
 * Returns:
 *   - `WorkspaceEditDTO` (1-based ranges, absolute paths) when the server
 *     answered; `{ changes: {} }` means "server answered: nothing to edit".
 *   - `null` when no server is available or the request failed — the
 *     router surfaces a friendly error to the editor.
 */
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
    if (process.env.MCP_LSP_DEBUG === '1') {
      const tail = acq.handle.stderrTail?.slice(-200) ?? '';
      console.error(
        `[lsp.serverRename] proj=${projectId} ${languageId} threw: ` +
        `${err instanceof Error ? err.message : String(err)}${tail ? ` — stderr: ${tail}` : ''}`,
      );
    }
    return null;
  }
}
