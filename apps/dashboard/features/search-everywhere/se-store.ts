/**
 * Search Everywhere + File Structure popup state — module store so any
 * command (keymap), button or empty-state card can open them.
 */
import { create } from 'zustand';

export type SeTab = 'all' | 'files' | 'symbols' | 'text' | 'commands';

interface SeState {
  open: boolean;
  tab: SeTab;
  structureOpen: boolean;
  keymapOpen: boolean;
  openWith: (tab: SeTab) => void;
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
  openWith: (tab) => set({ open: true, tab }),
  toggle: (tab) => {
    const s = get();
    // Same trigger again cycles tabs (IntelliJ double-Shift behavior);
    // different trigger while open just switches tab.
    if (s.open && s.tab === tab) set({ open: false });
    else set({ open: true, tab });
  },
  close: () => set({ open: false }),
  setTab: (tab) => set({ tab }),
  setStructureOpen: (structureOpen) => set({ structureOpen }),
  setKeymapOpen: (keymapOpen) => set({ keymapOpen }),
}));
