import type { HoverInfo, LspLocation } from '@mcp/api-bus';
import type { CodeIndexDB } from '@mcp/store/db.js';
import { relToAbsCanonical as relToAbs } from '@mcp/shared/utils/fs-canonical.js';
import { hoverToMarkdown, type LspHover } from '@mcp/services/lsp/lsp-protocol.js';
import {
  acquireLspWithDeadline,
  INTERACTIVE_LSP_ACQUIRE_DEADLINE_MS,
  type LspServerTarget,
} from './server-backend-acquire.js';
import { toLocations } from './server-backend-mappers.js';
import { getDoc } from './document-store.js';

export async function serverHover(
  db: CodeIndexDB,
  projectId: number,
  root: string,
  file: string,
  languageId: string,
  position: { line: number; column: number },
  signal?: AbortSignal,
  serverTarget?: string | LspServerTarget,
): Promise<HoverInfo | null | undefined> {
  const acquired = await acquireLspWithDeadline(
    db,
    projectId,
    languageId,
    INTERACTIVE_LSP_ACQUIRE_DEADLINE_MS,
    signal,
    'interactive',
    serverTarget,
  );
  if (!acquired) return undefined;
  const abs = relToAbs(root, file);
  const live = getDoc(projectId, file);
  if (live) acquired.handle.ensureOpen(abs, live.languageId, live.version, live.content);
  try {
    const markdown = hoverToMarkdown(
      await acquired.handle.hover(abs, position, signal) as LspHover | null,
    );
    return markdown ? { contents: markdown } : null;
  } catch {
    return undefined;
  }
}

async function serverLocations(
  method: 'definition' | 'references',
  db: CodeIndexDB,
  projectId: number,
  root: string,
  file: string,
  languageId: string,
  position: { line: number; column: number },
  signal?: AbortSignal,
  serverTarget?: string | LspServerTarget,
): Promise<LspLocation[] | null> {
  const acquired = await acquireLspWithDeadline(
    db,
    projectId,
    languageId,
    0,
    signal,
    'manual',
    serverTarget,
  );
  if (!acquired) return null;
  const abs = relToAbs(root, file);
  const live = getDoc(projectId, file);
  if (live) acquired.handle.ensureOpen(abs, live.languageId, live.version, live.content);
  try {
    return toLocations(await acquired.handle[method](abs, position, signal));
  } catch {
    return null;
  }
}

export function serverDefinition(
  db: CodeIndexDB,
  projectId: number,
  root: string,
  file: string,
  languageId: string,
  position: { line: number; column: number },
  signal?: AbortSignal,
  serverTarget?: string | LspServerTarget,
): Promise<LspLocation[] | null> {
  return serverLocations(
    'definition',
    db,
    projectId,
    root,
    file,
    languageId,
    position,
    signal,
    serverTarget,
  );
}

export function serverReferences(
  db: CodeIndexDB,
  projectId: number,
  root: string,
  file: string,
  languageId: string,
  position: { line: number; column: number },
  signal?: AbortSignal,
  serverTarget?: string | LspServerTarget,
): Promise<LspLocation[] | null> {
  return serverLocations(
    'references',
    db,
    projectId,
    root,
    file,
    languageId,
    position,
    signal,
    serverTarget,
  );
}
