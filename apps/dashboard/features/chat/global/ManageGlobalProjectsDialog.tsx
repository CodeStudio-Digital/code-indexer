import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Star, Search, X, Loader2, AlertTriangle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog.js';
import { Input } from '../../../components/ui/input.js';
import { Button } from '../../../components/ui/button.js';
import { useApi, apiPost, apiDelete } from '../../../hooks/useApi.js';
import { cn } from '../../../lib/utils.js';
import type { LinkedProject } from '../types.js';

interface ProjectRow {
  id: number;
  name: string;
  root_path: string;
}

export interface ManageGlobalProjectsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: number;
  linkedProjects: LinkedProject[];
  /** True while a run is in flight — mutations are rejected server-side (409),
   *  so the buttons are disabled and a hint is shown. */
  streaming: boolean;
  /** Refetch the session so the chip count + file tree pick up the change. */
  onChanged: () => void;
}

/**
 * Manage the projects in an existing global session's virtual workspace — attach
 * a new project (sometimes needed mid-investigation) or remove a linked one. The
 * primary and the last remaining project can't be removed. Attaching warms the
 * union index immediately; the agent spans the new root on its next message.
 */
export function ManageGlobalProjectsDialog({
  open,
  onOpenChange,
  sessionId,
  linkedProjects,
  streaming,
  onChanged,
}: ManageGlobalProjectsDialogProps) {
  const { t } = useTranslation(['chat', 'common']);
  const { data: projects } = useApi<ProjectRow[]>(open ? '/projects' : '');
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const linkedIds = useMemo(
    () => new Set(linkedProjects.map((p) => p.project_id)),
    [linkedProjects],
  );

  // Projects available to ADD: everything not already linked (the `/projects`
  // list already excludes synthetic union projects). Filtered by the search box.
  const addable = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (projects ?? [])
      .filter((p) => !linkedIds.has(p.id))
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.root_path.toLowerCase().includes(q));
  }, [projects, linkedIds, query]);

  const canRemove = linkedProjects.length > 1;

  const run = async (id: number, fn: () => Promise<unknown>) => {
    setError(null);
    setBusyId(id);
    try {
      await fn();
      onChanged();
      window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const attach = (id: number) =>
    run(id, () => apiPost(`/coder/sessions/${sessionId}/projects`, { project_id: id }));
  const detach = (id: number) =>
    run(id, () => apiDelete(`/coder/sessions/${sessionId}/projects/${id}`));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('chat:global.manageTitle')}</DialogTitle>
          <DialogDescription>{t('chat:global.manageDescription')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 min-w-0">
          {streaming && (
            <div className="flex items-center gap-2 rounded border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-600 dark:text-amber-400">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              {t('chat:global.busyWhileStreaming')}
            </div>
          )}
          {error && (
            <div className="rounded border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive">
              {error}
            </div>
          )}

          {/* Linked projects — remove with the × (not the primary / last one). */}
          <div className="space-y-1.5 min-w-0">
            <p className="text-[11px] font-medium text-muted-foreground">{t('chat:global.linkedProjects')}</p>
            <div className="w-full overflow-hidden rounded border divide-y">
              {linkedProjects.map((p) => {
                const removable = canRemove && !p.is_primary && !streaming;
                return (
                  <div key={p.project_id} className="flex w-full min-w-0 items-center gap-2 px-2 py-1.5 text-xs">
                    {p.is_primary ? (
                      <Star className="h-3.5 w-3.5 shrink-0 fill-current text-amber-500" />
                    ) : (
                      <span className="h-3.5 w-3.5 shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium truncate">{p.name}</span>
                        {p.is_primary && (
                          <span className="shrink-0 rounded bg-muted px-1 text-[9px] uppercase text-muted-foreground">
                            {t('chat:global.primaryBadge')}
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-muted-foreground truncate font-mono">{p.root_path}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => detach(p.project_id)}
                      disabled={!removable || busyId != null}
                      title={
                        p.is_primary
                          ? t('chat:global.cannotRemovePrimary')
                          : !canRemove
                            ? t('chat:global.cannotRemoveLast')
                            : t('chat:global.removeProject')
                      }
                      aria-label={t('chat:global.removeProject')}
                      className="shrink-0 p-1 rounded text-muted-foreground hover:bg-muted hover:text-destructive disabled:opacity-30 disabled:hover:bg-transparent"
                    >
                      {busyId === p.project_id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Add a project to the workspace. */}
          <div className="space-y-1.5 min-w-0">
            <p className="text-[11px] font-medium text-muted-foreground">{t('chat:global.addProjects')}</p>
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                className="pl-7"
                placeholder={t('chat:global.searchProjects')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="max-h-44 w-full overflow-y-auto overflow-x-hidden rounded border divide-y">
              {addable.length === 0 && (
                <div className="px-3 py-4 text-xs text-muted-foreground">{t('chat:global.noProjectsToAdd')}</div>
              )}
              {addable.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => attach(p.id)}
                  disabled={streaming || busyId != null}
                  className="flex w-full min-w-0 items-center gap-2 px-2 py-1.5 text-xs text-left hover:bg-accent/50 disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{p.name}</div>
                    <div className="text-[10px] text-muted-foreground truncate font-mono">{p.root_path}</div>
                  </div>
                  {busyId === p.id && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />}
                </button>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common:actions.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
