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

interface EnvironmentListProps {
  environments: ApiEnvironment[];
  selectedEnvId: number | null;
  onSelect: (id: number) => void;
  onEdit: (id: number) => void;
  onDelete: (id: number) => void;
  className?: string;
}

/** Shared environment list used by both the modal and the API left dock. */
export function EnvironmentList({
  environments,
  selectedEnvId,
  onSelect,
  onEdit,
  onDelete,
  className,
}: EnvironmentListProps) {
  const { t } = useTranslation('apiClient');
  const del = async (environment: ApiEnvironment) => {
    if (await confirm({
      title: t('envManager.deleteConfirmTitle', { name: environment.name }),
      description: t('envManager.deleteConfirmBody'),
      tone: 'destructive',
    })) onDelete(environment.id);
  };

  if (environments.length === 0) {
    return <p className={cn('px-3 py-6 text-center text-xs text-muted-foreground', className)}>{t('envManager.emptyState')}</p>;
  }

  return (
    <div className={cn('min-h-0 overflow-auto divide-y divide-border/40', className)}>
      {environments.map((environment) => (
        <div key={environment.id} className={cn('group flex items-center gap-2 px-3 py-2', environment.id === selectedEnvId && 'bg-[var(--workbench-selection)]')}>
          <button className="min-w-0 flex-1 text-left" onClick={() => onSelect(environment.id)} title={t('envManager.useThisEnv')}>
            <div className="flex items-center gap-1.5 truncate text-xs font-medium">
              {environment.id === selectedEnvId && <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />}
              <span className="truncate">{environment.name}</span>
              {environment.is_default && <Star className="h-3 w-3 shrink-0 text-amber-500" aria-label={t('envManager.defaultLabel')} />}
            </div>
            {environment.base_url && <div className="truncate font-mono text-[10px] text-muted-foreground">{environment.base_url}</div>}
          </button>
          <Button type="button" size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100" title={t('envManager.edit')} onClick={() => onEdit(environment.id)}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button type="button" size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground opacity-0 hover:text-red-500 group-hover:opacity-100 focus-visible:opacity-100" title={t('envManager.delete')} onClick={() => void del(environment)}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
    </div>
  );
}

export function EnvManagerDialog({ environments, selectedEnvId, open, onOpenChange, onSelect, onEdit, onDelete, onNew }: Props) {
  const { t } = useTranslation('apiClient');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><Globe className="h-4 w-4" /> {t('envManager.title')}</DialogTitle></DialogHeader>
        <EnvironmentList
          environments={environments}
          selectedEnvId={selectedEnvId}
          onSelect={(id) => { onSelect(id); onOpenChange(false); }}
          onEdit={onEdit}
          onDelete={onDelete}
          className="max-h-[60vh] rounded-md border"
        />
        <div className="flex justify-end">
          <Button size="sm" variant="outline" className="h-7 gap-1" onClick={onNew}><Plus className="h-3.5 w-3.5" /> {t('envManager.newEnvironment')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
