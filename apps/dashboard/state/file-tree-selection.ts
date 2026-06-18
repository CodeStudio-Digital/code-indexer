/**
 * Seleção do Explorer (modelo IntelliJ): clique simples seleciona, Ctrl/Cmd
 * toggla, Shift faz intervalo sobre a ORDEM VISÍVEL das linhas.
 *
 * Store IRMÃO do file-tree — NÃO compartilha o `version` dele de propósito: a
 * seleção muda a cada clique e não pode re-achatar `rows` nem re-renderizar a
 * árvore inteira. Cada linha assina só o próprio bit (`selected.has(path)`),
 * então só ela re-renderiza quando entra/sai da seleção.
 */
import { create } from 'zustand';

interface SelectionState {
  projectId: number | null;
  /** Paths selecionados (POSIX, relativos ao projeto). */
  selected: Set<string>;
  /** Origem do shift-range (ancorada no último clique simples/toggle). */
  anchor: string | null;
  /** Cursor — fim do range / linha-líder do teclado. */
  lead: string | null;
  /** Bumped a cada mutação (para consumidores que querem reagir a qualquer mudança). */
  version: number;

  /** Reset na troca de projeto (idempotente). */
  init: (projectId: number) => void;
  /** Clique simples: seleção vira {path}. */
  setSingle: (path: string) => void;
  /** Ctrl/Cmd+clique: toggla a presença de `path`. */
  toggle: (path: string) => void;
  /** Shift+clique: intervalo contíguo de `anchor`..`path` sobre `order`. */
  selectRange: (path: string, order: string[]) => void;
  /** Ctrl/Cmd+A: tudo da ordem visível. */
  selectAll: (order: string[]) => void;
  clear: () => void;
  /** Remove `removed` + descendentes (`path/...`) da seleção. */
  prune: (removed: string[]) => void;
}

export const useSelectionStore = create<SelectionState>((set, get) => ({
  projectId: null,
  selected: new Set(),
  anchor: null,
  lead: null,
  version: 0,

  init: (projectId) => {
    if (get().projectId === projectId) return;
    set({ projectId, selected: new Set(), anchor: null, lead: null, version: 0 });
  },

  setSingle: (path) =>
    set((s) => ({ selected: new Set([path]), anchor: path, lead: path, version: s.version + 1 })),

  toggle: (path) =>
    set((s) => {
      const next = new Set(s.selected);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { selected: next, anchor: path, lead: path, version: s.version + 1 };
    }),

  selectRange: (path, order) =>
    set((s) => {
      const a = s.anchor ?? s.lead ?? path;
      const i = order.indexOf(a);
      const j = order.indexOf(path);
      // Âncora fora da ordem atual (colapsou/filtrou) → cai para seleção simples.
      if (i < 0 || j < 0) return { selected: new Set([path]), anchor: path, lead: path, version: s.version + 1 };
      const [lo, hi] = i <= j ? [i, j] : [j, i];
      // anchor inalterado — permite estender/encolher o range com cliques shift sucessivos.
      return { selected: new Set(order.slice(lo, hi + 1)), lead: path, version: s.version + 1 };
    }),

  selectAll: (order) =>
    set((s) => ({ selected: new Set(order), lead: order[order.length - 1] ?? null, version: s.version + 1 })),

  clear: () =>
    set((s) =>
      s.selected.size === 0 && !s.anchor && !s.lead
        ? {}
        : { selected: new Set(), anchor: null, lead: null, version: s.version + 1 },
    ),

  prune: (removed) =>
    set((s) => {
      if (s.selected.size === 0) return {};
      const next = new Set(s.selected);
      let changed = false;
      for (const r of removed) {
        for (const p of [...next]) {
          if (p === r || p.startsWith(`${r}/`)) {
            next.delete(p);
            changed = true;
          }
        }
      }
      if (!changed) return {};
      const anchor = s.anchor && next.has(s.anchor) ? s.anchor : null;
      const lead = s.lead && next.has(s.lead) ? s.lead : null;
      return { selected: next, anchor, lead, version: s.version + 1 };
    }),
}));

/** Snapshot dos paths selecionados (para delete/copy, lidos no clique). */
export function currentSelection(): string[] {
  return [...useSelectionStore.getState().selected];
}
