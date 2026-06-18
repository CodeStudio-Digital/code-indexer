/**
 * Atalhos de teclado do Explorer ciente de seleção: Delete/Backspace apaga a
 * seleção, Escape limpa, Ctrl/Cmd+A seleciona tudo visível (só com a árvore
 * focada — não sequestra o select-all global). Espelha o guard de input do F2
 * (não dispara quando o foco está num campo editável).
 */
import { useEffect } from 'react';
import { useSelectionStore } from '../../../state/file-tree-selection.js';
import { deleteSelection } from './delete-selection.js';

interface TreeKeyboardOpts {
  projectId: number;
  scrollRef: React.RefObject<HTMLElement | null>;
  /** Ordem visível atual (paths) — modo árvore ou lista filtrada. */
  getOrder: () => string[];
  onMutated: () => void;
}

function inEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || !!el?.isContentEditable;
}

export function useTreeKeyboard({ projectId, scrollRef, getOrder, onMutated }: TreeKeyboardOpts): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (inEditable(e.target)) return;
      // Todos os atalhos exigem que a própria árvore tenha o foco — evita deletar
      // arquivos / sequestrar Escape/Ctrl+A quando o foco está noutro lugar.
      if (!scrollRef.current?.contains(document.activeElement)) return;
      const sel = useSelectionStore.getState();

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (sel.selected.size === 0) return;
        e.preventDefault();
        void deleteSelection(projectId, [...sel.selected], onMutated);
        return;
      }
      if (e.key === 'Escape') {
        if (sel.selected.size === 0) return;
        e.preventDefault();
        sel.clear();
        return;
      }
      if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        sel.selectAll(getOrder());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [projectId, scrollRef, getOrder, onMutated]);
}
