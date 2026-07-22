import type { CodeIndexDB } from '@mcp/store/db.js';
import { relToAbsCanonical as relToAbs } from '@mcp/shared/utils/fs-canonical.js';
import {
  acquireLspWithDeadline,
  INTERACTIVE_LSP_ACQUIRE_DEADLINE_MS,
} from './server-backend-acquire.js';
import { getDoc } from './document-store.js';
import { MONACO_SEMANTIC_LEGEND, remapSemanticTokens } from './semantic-tokens-remap.js';

/** Fetch semantic tokens and translate the server legend onto Monaco's legend. */
export async function serverSemanticTokens(
  db: CodeIndexDB,
  projectId: number,
  root: string,
  file: string,
  languageId: string,
  signal?: AbortSignal,
): Promise<{ data: number[] } | null> {
  const acquired = await acquireLspWithDeadline(
    db,
    projectId,
    languageId,
    INTERACTIVE_LSP_ACQUIRE_DEADLINE_MS,
    signal,
    'background',
  );
  if (!acquired) return null;
  const legend = acquired.handle.semanticTokensLegend();
  if (!legend) return null;
  const abs = relToAbs(root, file);
  const live = getDoc(projectId, file);
  if (live) acquired.handle.ensureOpen(abs, live.languageId, live.version, live.content);
  try {
    const raw = await acquired.handle.semanticTokens(abs, signal) as { data?: number[] } | null;
    if (!raw?.data?.length) return null;
    return { data: remapSemanticTokens(raw.data, legend, MONACO_SEMANTIC_LEGEND) };
  } catch {
    return null;
  }
}
