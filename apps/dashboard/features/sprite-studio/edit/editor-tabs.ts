/**
 * Editor tabs — the open IMAGES of the multi-tab editor (Photoshop-style).
 * One tab per image: a specific VERSION, or the blank doc of a brand-new
 * asset — NOT per asset, so editing two frames of the same character opens
 * two tabs instead of replacing one. The ACTIVE tab is derived from the
 * studio's activeAssetId+activeVersionId (focusing a tab selects both), so
 * the tab bar only owns the open LIST + labels. Module-level (one studio
 * open at a time; SpriteStudioView resets it on project switch).
 */
import { create } from 'zustand';

export interface EditorTab {
  /** Stable identity: the versionId, or `new:<assetId>` for a blank asset. */
  key: string;
  assetId: string;
  versionId: string | null;
  label: string;
}

/** The tab key for an (asset, version) pair — shared by open/active/close. */
export const editorTabKey = (assetId: string, versionId: string | null): string =>
  versionId != null ? String(versionId) : `new:${assetId}`;

interface EditorTabsState {
  tabs: EditorTab[];
  /** Open (or relabel) a tab; keeps order, dedups by key. */
  openTab: (tab: EditorTab) => void;
  closeTab: (key: string) => void;
  /** Close every tab of one asset (asset deletion). */
  closeAssetTabs: (assetId: string) => void;
  reset: () => void;
}

export const useEditorTabs = create<EditorTabsState>((set) => ({
  tabs: [],
  openTab: (tab) =>
    set((s) => {
      const i = s.tabs.findIndex((t) => t.key === tab.key);
      if (i < 0) return { tabs: [...s.tabs, tab] };
      if (s.tabs[i].label === tab.label) return s;
      const tabs = s.tabs.slice();
      tabs[i] = tab;
      return { tabs };
    }),
  closeTab: (key) => set((s) => ({ tabs: s.tabs.filter((t) => t.key !== key) })),
  closeAssetTabs: (assetId) => set((s) => ({ tabs: s.tabs.filter((t) => t.assetId !== assetId) })),
  reset: () => set({ tabs: [] }),
}));
