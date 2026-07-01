/**
 * Multi-delete do Explorer: 1 confirm para N itens, depois `files.delete` em
 * loop (Promise.allSettled). Reusa 100% da lógica de segurança/index do verbo
 * existente (sem verbo batch novo); N é uma seleção humana e o bus é
 * in-process (Electron IPC), então N round-trips é trivial.
 *
 * `recursive: true` é seguro para arquivos (o backend só o usa no ramo de
 * diretório; arquivo cai em `fs.unlink`), então não precisamos resolver
 * `isDir` por path. Cada delete de arquivo dispara o snapshot `pre-delete`
 * no backend (Local History) → deleção recuperável.
 */
import i18n from '../../../i18n/index.js';
import { apiCall } from '../../../lib/api-client.js';
import { confirm, toast } from '../../../components/ui/prompt-dialog.js';
import { useSelectionStore } from '../../../state/file-tree-selection.js';

/**
 * Mantém só os paths "raiz": descarta qualquer path cujo ancestral também esteja
 * na lista (deletar o pai recursivamente já remove o filho → evita ENOENT).
 */
export function dropNested(paths: string[]): string[] {
  const sorted = [...paths].sort((a, b) => a.length - b.length);
  const roots: string[] = [];
  for (const p of sorted) {
    if (!roots.some((r) => p === r || p.startsWith(`${r}/`))) roots.push(p);
  }
  return roots;
}

export async function deleteSelection(
  projectId: number,
  paths: string[],
  onMutated: () => void,
): Promise<void> {
  const roots = dropNested(paths);
  const n = roots.length;
  if (n === 0) return;

  const ok = await confirm({
    title: i18n.t('workspace:fileTree.deleteItemsTitle', { count: n }),
    description: i18n.t('workspace:fileTree.deleteItemsBody', { count: n, path: roots[0] }),
    confirmLabel: i18n.t('workspace:fileTree.delete'),
    tone: 'destructive',
  });
  if (!ok) return;

  const results = await Promise.allSettled(
    roots.map((path) => apiCall<{ ok: true }>('files.delete', { projectId, path, recursive: true })),
  );

  // Poda otimista da seleção (fs-events também atualiza a árvore; onMutated é fallback).
  useSelectionStore.getState().prune(roots);
  onMutated();

  const failed = results.filter((r) => r.status === 'rejected').length;
  if (failed === 0) {
    toast.success(i18n.t('workspace:fileTree.deletedItems', { count: n }));
  } else {
    toast.error(i18n.t('workspace:fileTree.deletedPartial', { done: n - failed, total: n }), {
      description: i18n.t('workspace:fileTree.deletedPartialBody'),
    });
  }
}
