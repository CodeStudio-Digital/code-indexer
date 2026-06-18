/**
 * Captura do Local History — lê a PRÉ-imagem de um arquivo antes de um write
 * (Ctrl+S) ou delete e grava como revisão. Best-effort e fail-open: qualquer
 * erro aqui NUNCA pode rejeitar o save/delete (chamado com `void`).
 *
 * Gates: arquivo > MAX_BYTES ou binário (sniff de NUL) → linha `oversized`
 * (metadata, sem blob). 1º save (ENOENT) → tombstone `existed_before=0`.
 */
import { promises as fs } from 'node:fs';
import type { HistoryKind } from '@mcp/store/file-local-history-store.js';
import type { HandlerDeps } from '../types.js';

const MAX_BYTES = Number(process.env.MCP_LOCAL_HISTORY_MAX_BYTES ?? 1024 * 1024);
const MAX_PER_FILE = Number(process.env.MCP_LOCAL_HISTORY_MAX_PER_FILE ?? 50);
const MAX_AGE_DAYS = Number(process.env.MCP_LOCAL_HISTORY_MAX_AGE_DAYS ?? 14);

function isBinaryLike(s: string): boolean {
  const sample = s.length > 8192 ? s.slice(0, 8192) : s;
  return sample.indexOf(String.fromCharCode(0)) >= 0;
}

/**
 * Captura a pré-imagem de `readFrom` como uma revisão de `rel` no projeto.
 * `kind`: 'save' (pré-Ctrl+S), 'pre-delete' (pré-unlink), etc.
 */
export async function captureLocalHistory(
  deps: HandlerDeps,
  projectId: number,
  rel: string,
  opts: { kind: HistoryKind; readFrom: string },
): Promise<void> {
  try {
    const path = rel.replace(/\\/g, '/');
    let content: string | null = null;
    let oversized = false;
    let size: number | undefined;
    try {
      const stat = await fs.stat(opts.readFrom);
      if (!stat.isFile()) return; // dir/symlink — nada a capturar
      size = stat.size;
      if (stat.size > MAX_BYTES) {
        oversized = true;
      } else {
        const buf = await fs.readFile(opts.readFrom, 'utf8');
        if (isBinaryLike(buf)) oversized = true;
        else content = buf;
      }
    } catch (err) {
      // Só o 'save' de um arquivo inexistente vira tombstone (restore = delete).
      // Para outros kinds, ENOENT/erro de leitura = nada a capturar (fail-open).
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' && opts.kind === 'save') {
        content = null;
        size = 0;
      } else {
        return;
      }
    }

    const store = deps.fileLocalHistoryStore;
    const rev = store.recordRevision({ projectId, path, content, kind: opts.kind, oversized, size });
    if (rev) store.pruneForFile(projectId, path, { maxPerFile: MAX_PER_FILE, maxAgeDays: MAX_AGE_DAYS });
  } catch {
    /* fail-open — o histórico jamais quebra o save/delete */
  }
}
