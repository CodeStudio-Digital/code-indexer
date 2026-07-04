/**
 * Sticky footer shown while any versions are multi-selected (shared by the LEFT
 * browser and the RIGHT inspector). Surfaces the count and the batch actions:
 * add the selection to the timeline, bulk-delete it, or clear. Reads the count
 * from the session store; the actions are wired by the parent.
 */
import { ListPlus, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../../components/ui/button.js';
import { useAnimateSession } from '../animate-session-store.js';

export function SelectionActionBar({
  onAddToTimeline,
  onDelete,
  busy,
}: {
  onAddToTimeline: () => void;
  onDelete: () => void;
  busy?: boolean;
}) {
  const { t } = useTranslation('spriteStudio');
  const count = useAnimateSession((s) => s.selected.size);
  const clear = useAnimateSession((s) => s.clearSelection);
  if (count === 0) return null;

  return (
    <div className="flex shrink-0 items-center gap-1.5 border-t bg-card px-2 py-1.5 text-[11px]">
      <span className="font-medium">{t('frames.selectedCount', { n: count })}</span>
      <div className="ml-auto flex items-center gap-1">
        <Button size="sm" variant="outline" className="h-6 gap-1 px-1.5 text-[10px]" disabled={busy} onClick={onAddToTimeline}>
          <ListPlus className="h-3 w-3" /> {t('frames.addSelected')}
        </Button>
        <Button size="sm" variant="outline" className="h-6 gap-1 px-1.5 text-[10px] text-red-400 hover:text-red-300" disabled={busy} onClick={onDelete}>
          <Trash2 className="h-3 w-3" /> {t('frames.deleteSelected')}
        </Button>
        <Button size="sm" variant="ghost" className="h-6 w-6 p-0" title={t('frames.clearSelection')} onClick={clear}>
          <X className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}
