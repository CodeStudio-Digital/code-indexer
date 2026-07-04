/**
 * Left library panel — composition of SearchBar + CategoryTree + the
 * virtualized AssetGrid, plus the "New asset" entry point. Pure composition:
 * all state lives in useSpriteStudio; this panel only wires props through.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import type { CategoryGroupId, SpriteAsset, SpriteCategory } from '../types.js';
import { SearchBar } from './SearchBar.js';
import { CategoryTree } from './CategoryTree.js';
import { AssetGrid } from './AssetGrid.js';
import { NewAssetDialog } from './NewAssetDialog.js';

export function LibraryPanel({
  projectId,
  assets,
  filteredAssets,
  activeCategory,
  onCategory,
  query,
  onQuery,
  activeAssetId,
  onSelect,
  onOpen,
  defaultSize,
  onCreate,
}: {
  projectId: number;
  /** Unfiltered library (tree counts). */
  assets: SpriteAsset[];
  /** After group filter + search (grid contents). */
  filteredAssets: SpriteAsset[];
  activeCategory: CategoryGroupId | 'all';
  onCategory: (id: CategoryGroupId | 'all') => void;
  query: string;
  onQuery: (q: string) => void;
  activeAssetId: number | null;
  onSelect: (id: number) => void;
  /** Double-click on a card — opens the asset in the editor (M3). */
  onOpen?: (id: number) => void;
  defaultSize?: { width: number; height: number };
  onCreate: (input: { name: string; category: SpriteCategory; width: number; height: number }) => Promise<void>;
}) {
  const { t } = useTranslation('spriteStudio');
  const [newOpen, setNewOpen] = useState(false);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 space-y-2 border-b p-2">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {t('library.title')}
          </span>
          <Button size="sm" variant="outline" className="h-6 gap-1 px-1.5 text-[11px]" onClick={() => setNewOpen(true)}>
            <Plus className="h-3 w-3" /> {t('library.newAsset')}
          </Button>
        </div>
        <SearchBar query={query} onQuery={onQuery} />
      </div>
      <div className="max-h-[45%] shrink-0 overflow-y-auto border-b px-1">
        <CategoryTree
          projectId={projectId}
          assets={assets}
          activeCategory={activeCategory}
          onCategory={onCategory}
        />
      </div>
      <div className="min-h-0 flex-1">
        <AssetGrid
          assets={filteredAssets}
          activeAssetId={activeAssetId}
          onSelect={onSelect}
          onOpen={onOpen}
        />
      </div>
      <NewAssetDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        defaultSize={defaultSize}
        onCreate={onCreate}
      />
    </div>
  );
}
