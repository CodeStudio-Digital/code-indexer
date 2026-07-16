/**
 * Search Everywhere + File Structure popup state — module store so any
 * command (keymap), button or empty-state card can open them.
 */
import { create } from 'zustand';

export type SeTab = 'all' | 'files' | 'symbols' | 'text' | 'semantic' | 'commands';

interface SeState {
  open: boolean;
  tab: SeTab;
  structureOpen: boolean;
  keymapOpen: boolean;
  /** One-shot query seeded by an editor action. */
  initialQuery: string | null;
  openWith: (tab: SeTab) => void;
  openSemantic: (query: string) => void;
  consumeInitialQuery: () => string | null;
  toggle: (tab: SeTab) => void;
  close: () => void;
  setTab: (tab: SeTab) => void;
  setStructureOpen: (open: boolean) => void;
  setKeymapOpen: (open: boolean) => void;
}

export const useSeStore = create<SeState>((set, get) => ({
  open: false,
  tab: 'all',
  structureOpen: false,
  keymapOpen: false,
  initialQuery: null,
  openWith: (tab) => set({ open: true, tab, initialQuery: null }),
  openSemantic: (query) => set({ open: true, tab: 'semantic', initialQuery: query.trim() }),
  consumeInitialQuery: () => {
    const query = get().initialQuery;
    set({ initialQuery: null });
    return query;
  },
  toggle: (tab) => {
    const s = get();
    // Same trigger again cycles tabs (IntelliJ double-Shift behavior);
    // different trigger while open just switches tab.
    if (s.open && s.tab === tab) set({ open: false, initialQuery: null });
    else set({ open: true, tab, initialQuery: null });
  },
  close: () => set({ open: false }),
  setTab: (tab) => set({ tab }),
  setStructureOpen: (structureOpen) => set({ structureOpen }),
  setKeymapOpen: (keymapOpen) => set({ keymapOpen }),
}));
