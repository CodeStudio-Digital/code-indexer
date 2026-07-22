import type { CodeIndexDB } from '@mcp/store/db.js';
import { relToAbsCanonical as relToAbs } from '@mcp/shared/utils/fs-canonical.js';
import type {
  LspAcquireIntent,
  LspServerManager,
} from '@mcp/services/lsp/lsp-server-manager.js';
import {
  acquireLspWithDeadline,
  type LspServerTarget,
} from './server-backend-acquire.js';
import { getDoc } from './document-store.js';

export type Acquired = NonNullable<Awaited<ReturnType<LspServerManager['acquire']>>>;

/** Shared acquire + live-buffer synchronization for document operations. */
export async function acquireWithDoc(
  db: CodeIndexDB,
  projectId: number,
  root: string,
  file: string,
  languageId: string,
  serverTarget?: string | LspServerTarget,
  acquireDeadlineMs?: number,
  signal?: AbortSignal,
  intent: LspAcquireIntent = 'manual',
): Promise<{ acq: Acquired; abs: string } | null> {
  const acq = await acquireLspWithDeadline(
    db,
    projectId,
    languageId,
    acquireDeadlineMs ?? 0,
    signal,
    intent,
    serverTarget,
  );
  if (!acq) return null;
  const abs = relToAbs(root, file);
  const live = getDoc(projectId, file);
  if (live) acq.handle.ensureOpen(abs, live.languageId, live.version, live.content);
  return { acq, abs };
}

export function debugLspOperation(
  operation: string,
  projectId: number,
  languageId: string,
  error: unknown,
  acquired?: Acquired,
): void {
  if (process.env.MCP_LSP_DEBUG !== '1') return;
  const tail = acquired?.handle.stderrTail?.slice(-200) ?? '';
  console.error(
    `[lsp.${operation}] proj=${projectId} ${languageId} threw: `
    + `${error instanceof Error ? error.message : String(error)}`
    + `${tail ? ` — stderr: ${tail}` : ''}`,
  );
}
