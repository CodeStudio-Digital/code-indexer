/**
 * Collections manager modal — see every collection, switch to one, rename or
 * delete it. Keeps these actions out of the sidebar so the request list gets the
 * vertical space.
 */
import { CheckCircle2, Pencil, Trash2, Library } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { Button } from '../../components/ui/button.js';
import { prompt, confirm } from '../../components/ui/prompt-dialog.js';
import { cn } from '../../lib/utils.js';
import type { ApiCollection } from './types.js';

interface Props {
  collections: ApiCollection[];
  activeCollectionId: number | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSelect: (id: number) => void;
  onRename: (id: number, name: string) => void;
  onDelete: (id: number) => void;
}

export function CollectionsDialog({ collections, activeCollectionId, open, onOpenChange, onSelect, onRename, onDelete }: Props) {
  const { t } = useTranslation('apiClient');
  const rename = async (c: ApiCollection) => {
    const n = await prompt({ title: t('collectionsDialog.renameTitle'), defaultValue: c.name });
    if (n?.trim() && n.trim() !== c.name) onRename(c.id, n.trim());
  };
  const del = async (c: ApiCollection) => {
    if (await confirm({ title: t('collectionsDialog.deleteConfirmTitle', { name: c.name }), description: t('collectionsDialog.deleteConfirmBody'), tone: 'destructive' })) onDelete(c.id);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><Library className="h-4 w-4" /> {t('collectionsDialog.title')}</DialogTitle></DialogHeader>
        {collections.length === 0 ? (
          <p className="text-xs text-muted-foreground py-4 text-center">{t('collectionsDialog.emptyState')}</p>
        ) : (
          <div className="max-h-[60vh] overflow-auto border rounded-md divide-y divide-border/40">
            {collections.map((c) => (
              <div key={c.id} className={cn('group flex items-center gap-2 px-3 py-2', c.id === activeCollectionId && 'bg-muted/50')}>
                <button
                  className="flex-1 min-w-0 text-left"
                  onClick={() => { onSelect(c.id); onOpenChange(false); }}
                  title={t('collectionsDialog.openTitle')}
                >
                  <div className="flex items-center gap-1.5 text-sm font-medium truncate">
                    {c.id === activeCollectionId && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />}
                    <span className="truncate">{c.name}</span>
                  </div>
                  {c.spec_source && <div className="text-[11px] text-muted-foreground font-mono truncate">{c.spec_source}</div>}
                </button>
                <Button type="button" size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground opacity-0 group-hover:opacity-100" title={t('collectionsDialog.rename')} onClick={() => void rename(c)}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button type="button" size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-red-500 opacity-0 group-hover:opacity-100" title={t('collectionsDialog.delete')} onClick={() => void del(c)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
