/**
 * Toolbar of the Frames browser: search-by-batch, a "select mode" toggle
 * (reveals checkboxes so single clicks still drag/open), expand/collapse-all,
 * and the sprite-sheet import trigger.
 */
import { ChevronsDownUp, ChevronsUpDown, ImageUp, MousePointerClick, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../../lib/utils.js';
import { Button } from '../../../../components/ui/button.js';
import { useAnimateSession } from '../animate-session-store.js';

export function FramesBrowserToolbar({
  query,
  onQuery,
  onExpandAll,
  onCollapseAll,
  onImport,
}: {
  query: string;
  onQuery: (q: string) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  onImport: () => void;
}) {
  const { t } = useTranslation('spriteStudio');
  const selectMode = useAnimateSession((s) => s.selectMode);
  const setSelectMode = useAnimateSession((s) => s.setSelectMode);

  return (
    <div className="flex flex-col gap-1 border-b p-1.5">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={t('frames.searchPlaceholder')}
          className="h-7 w-full rounded border bg-background pl-7 pr-2 text-[11px] outline-none focus:border-primary"
        />
      </div>
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant={selectMode ? 'default' : 'outline'}
          className={cn('h-6 gap-1 px-1.5 text-[10px]')}
          onClick={() => setSelectMode(!selectMode)}
          title={t('frames.selectMode')}
        >
          <MousePointerClick className="h-3 w-3" /> {t('frames.selectMode')}
        </Button>
        <Button size="sm" variant="ghost" className="h-6 w-6 p-0" title={t('frames.expandAll')} onClick={onExpandAll}>
          <ChevronsUpDown className="h-3 w-3" />
        </Button>
        <Button size="sm" variant="ghost" className="h-6 w-6 p-0" title={t('frames.collapseAll')} onClick={onCollapseAll}>
          <ChevronsDownUp className="h-3 w-3" />
        </Button>
        <Button size="sm" variant="outline" className="ml-auto h-6 gap-1 px-1.5 text-[10px]" title={t('frames.import')} onClick={onImport}>
          <ImageUp className="h-3 w-3" /> {t('frames.import')}
        </Button>
      </div>
    </div>
  );
}
