/**
 * Environments manager modal — list every environment, switch the active one,
 * edit or delete it. Creating/editing opens the EnvEditor form; this view is
 * just the list (mirrors CollectionsDialog).
 */
import { CheckCircle2, Pencil, Trash2, Star, Plus, Globe } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { Button } from '../../components/ui/button.js';
import { confirm } from '../../components/ui/prompt-dialog.js';
import { cn } from '../../lib/utils.js';
import type { ApiEnvironment } from './types.js';

interface Props {
  environments: ApiEnvironment[];
  selectedEnvId: number | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSelect: (id: number) => void;
  onEdit: (id: number) => void;
  onDelete: (id: number) => void;
  onNew: () => void;
}

export function EnvManagerDialog({ environments, selectedEnvId, open, onOpenChange, onSelect, onEdit, onDelete, onNew }: Props) {
  const { t } = useTranslation('apiClient');
  const del = async (e: ApiEnvironment) => {
    if (await confirm({ title: t('envManager.deleteConfirmTitle', { name: e.name }), description: t('envManager.deleteConfirmBody'), tone: 'destructive' })) onDelete(e.id);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><Globe className="h-4 w-4" /> {t('envManager.title')}</DialogTitle></DialogHeader>
        {environments.length === 0 ? (
          <p className="text-xs text-muted-foreground py-4 text-center">{t('envManager.emptyState')}</p>
        ) : (
          <div className="max-h-[60vh] overflow-auto border rounded-md divide-y divide-border/40">
            {environments.map((e) => (
              <div key={e.id} className={cn('group flex items-center gap-2 px-3 py-2', e.id === selectedEnvId && 'bg-muted/50')}>
                <button className="flex-1 min-w-0 text-left" onClick={() => { onSelect(e.id); onOpenChange(false); }} title={t('envManager.useThisEnv')}>
                  <div className="flex items-center gap-1.5 text-sm font-medium truncate">
                    {e.id === selectedEnvId && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />}
                    <span className="truncate">{e.name}</span>
                    {e.is_default && <Star className="h-3 w-3 text-amber-500 shrink-0" aria-label={t('envManager.defaultLabel')} />}
                  </div>
                  {e.base_url && <div className="text-[11px] text-muted-foreground font-mono truncate">{e.base_url}</div>}
                </button>
                <Button type="button" size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground opacity-0 group-hover:opacity-100" title={t('envManager.edit')} onClick={() => onEdit(e.id)}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button type="button" size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-red-500 opacity-0 group-hover:opacity-100" title={t('envManager.delete')} onClick={() => void del(e)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
        <div className="flex justify-end">
          <Button size="sm" variant="outline" className="h-7 gap-1" onClick={onNew}><Plus className="h-3.5 w-3.5" /> {t('envManager.newEnvironment')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
