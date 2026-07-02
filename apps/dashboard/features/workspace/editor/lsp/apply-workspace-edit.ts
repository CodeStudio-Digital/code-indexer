/**
 * Aplica um WorkspaceEdit do lsp.rename a arquivos SEM model Monaco aberto:
 * lê o conteúdo via files.read, aplica os edits DE TRÁS PARA FRENTE e grava
 * via files.write — o mesmo par read/write que save.ts usa.
 *
 * Regras:
 *  - `applyEditsToContent` é PURA (testável sem DOM/Monaco): ranges 1-based,
 *    início inclusivo / fim exclusivo — o shape do TextEditDTO do api-bus.
 *  - Tab aberta porém sem model (evicção LRU) e DIRTY é PULADA — gravar por
 *    cima do disco perderia as edições não salvas do usuário.
 *  - Tab aberta limpa sem model: o novo conteúdo é espelhado no store via
 *    applyExternalContent (mesmo caminho do reload-from-disk).
 *  - Imports de api-client/store são LAZY para manter o módulo importável em
 *    teste puro (vitest) sem puxar o runtime do renderer.
 */

export interface EditPosition { line: number; column: number }

export interface ContentEdit {
  range: { start: EditPosition; end: EditPosition };
  newText: string;
}

/** (line, column) 1-based → offset absoluto, clampado ao tamanho do conteúdo.
 *  Linha além do EOF clampa ao FIM do conteúdo (append), nunca ao início da
 *  última linha — senão um range fora de alcance substituiria texto real. */
function offsetOf(lineStarts: number[], contentLen: number, p: EditPosition): number {
  if (p.line > lineStarts.length) return contentLen;
  const base = lineStarts[Math.max(p.line, 1) - 1];
  return Math.min(base + Math.max(p.column - 1, 0), contentLen);
}

/**
 * Aplica edits a um conteúdo. Ordena por start DESC e aplica de trás para
 * frente — os offsets dos edits anteriores permanecem válidos sem recálculo
 * (inclusive múltiplos edits na mesma linha).
 */
export function applyEditsToContent(content: string, edits: ContentEdit[]): string {
  if (edits.length === 0) return content;
  const lineStarts: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') lineStarts.push(i + 1);
  }
  const resolved = edits.map((e) => ({
    start: offsetOf(lineStarts, content.length, e.range.start),
    end: offsetOf(lineStarts, content.length, e.range.end),
    newText: e.newText,
  }));
  resolved.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = content;
  for (const e of resolved) {
    out = out.slice(0, e.start) + e.newText + out.slice(Math.max(e.end, e.start));
  }
  return out;
}

/**
 * Aplica edits agrupados por arquivo (relpath do projeto → edits) a arquivos
 * fechados (sem model Monaco). Retorna quais foram gravados e quais pulados
 * (dirty sem model, binários/base64, falha de leitura/gravação).
 */
export async function applyWorkspaceEditToClosedFiles(
  projectId: number,
  byFile: ReadonlyMap<string, ContentEdit[]>,
): Promise<{ written: string[]; skipped: string[] }> {
  const written: string[] = [];
  const skipped: string[] = [];
  if (byFile.size === 0) return { written, skipped };

  const { apiCall } = await import('../../../../lib/api-client.js');
  const { useWorkspaceStore } = await import('../../../../state/workspace.js');

  type ReadResult =
    | { content: string; encoding?: 'utf8' | 'base64'; last_modified: string }
    | { notModified: true; last_modified: string };

  for (const [rel, edits] of byFile) {
    const tab = useWorkspaceStore.getState().openFiles.find(
      (f) => (f.kind === undefined || f.kind === 'file') && f.projectId === projectId && f.path === rel,
    );
    // Buffer não salvo sem model vivo — nunca sobrescrever o trabalho do usuário.
    if (tab?.dirty) { skipped.push(rel); continue; }
    try {
      const res = await apiCall<ReadResult>('files.read', { projectId, path: rel });
      if (!('content' in res) || res.encoding === 'base64') { skipped.push(rel); continue; }
      const next = applyEditsToContent(res.content, edits);
      const w = await apiCall<{ ok: true; last_modified: string }>('files.write', {
        projectId, path: rel, content: next,
      });
      // Tab aberta limpa sem model: espelha para a aba não reabrir com texto velho.
      if (tab) useWorkspaceStore.getState().applyExternalContent(projectId, rel, next, w.last_modified);
      written.push(rel);
    } catch {
      skipped.push(rel);
    }
  }
  return { written, skipped };
}
