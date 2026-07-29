import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Star, Search, Boxes, FolderOpen } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog.js';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../../components/ui/tabs.js';
import { Input } from '../../../components/ui/input.js';
import { Button } from '../../../components/ui/button.js';
import { toast } from '../../../components/ui/prompt-dialog.js';
import { useApi, apiPost } from '../../../hooks/useApi.js';
import { cn } from '../../../lib/utils.js';

interface ProjectRow {
  id: number;
  name: string;
  root_path: string;
}

interface WorkspaceRow {
  id: string;
  label: string;
  sessionCount: number;
}

export interface GlobalNewSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (opts: {
    title?: string;
    projectIds?: number[];
    primaryProjectId?: number;
    reuseSessionId?: string;
  }) => Promise<unknown> | void;
}

/**
 * Create a global (multi-project) session from selected real roots, or copy the
 * linked-root set from an existing global UUID bundle. All projects are
 * first-class; the primary star selects the default cwd.
 */
export function GlobalNewSessionDialog({ open, onOpenChange, onCreate }: GlobalNewSessionDialogProps) {
  const { t } = useTranslation(['chat', 'common']);
  const [mode, setMode] = useState<'new' | 'reuse'>('new');
  // `include_loose=1` so previously-added ad-hoc folders (mig 176) also show.
  const { data: projects } = useApi<ProjectRow[]>(open && mode === 'new' ? '/projects?include_loose=1' : '');
  const { data: workspaces } = useApi<WorkspaceRow[]>(open && mode === 'reuse' ? '/coder/global-workspaces' : '');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [primaryId, setPrimaryId] = useState<number | null>(null);
  const [reuseId, setReuseId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  // Loose folders the user just picked this session — merged into the list so a
  // brand-new ad-hoc folder is selectable before the `/projects` refetch lands.
  const [extraLoose, setExtraLoose] = useState<ProjectRow[]>([]);
  const [picking, setPicking] = useState(false);

  const isElectron = typeof window !== 'undefined' && !!window.electronAPI?.openDirectory;

  const merged = useMemo(() => {
    const byId = new Map<number, ProjectRow>();
    for (const p of projects ?? []) byId.set(p.id, p);
    for (const p of extraLoose) byId.set(p.id, p); // dedupe by id
    return [...byId.values()];
  }, [projects, extraLoose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return merged;
    return merged.filter((p) => p.name.toLowerCase().includes(q) || p.root_path.toLowerCase().includes(q));
  }, [merged, query]);

  // Pick an arbitrary folder via the native picker, register it as a LOOSE
  // ad-hoc project (idempotent on path), and add it to the selection.
  const pickFolder = async () => {
    if (!isElectron) {
      toast.message(t('chat:global.loosePickerUnavailable'));
      return;
    }
    setPicking(true);
    try {
      const dir = await window.electronAPI!.openDirectory!();
      if (!dir) return;
      const created = await apiPost<ProjectRow>('/projects', { root_path: dir, loose: true });
      setExtraLoose((prev) => (prev.some((p) => p.id === created.id) ? prev : [...prev, created]));
      setQuery(''); // clear filter so the freshly-added folder is visible
      setSelected((prev) => {
        const next = new Set(prev);
        next.add(created.id);
        return next;
      });
      setPrimaryId((prev) => prev ?? created.id); // first pick becomes primary
    } catch (err) {
      toast.error(t('chat:global.addFolderFailed'), {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setPicking(false);
    }
  };

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        if (primaryId === id) setPrimaryId(null);
      } else {
        next.add(id);
        if (primaryId === null) setPrimaryId(id); // first pick becomes primary
      }
      return next;
    });
  };

  const reset = () => {
    setMode('new');
    setQuery('');
    setSelected(new Set());
    setPrimaryId(null);
    setReuseId(null);
    setTitle('');
    setExtraLoose([]);
  };

  const effectivePrimary = primaryId != null && selected.has(primaryId)
    ? primaryId
    : (selected.values().next().value ?? null);
  const canCreate = !busy && (mode === 'new' ? (selected.size >= 1 && effectivePrimary != null) : reuseId != null);

  const submit = async () => {
    if (!canCreate) return;
    setBusy(true);
    try {
      if (mode === 'reuse' && reuseId != null) {
        await onCreate({ reuseSessionId: reuseId, title: title.trim() || undefined });
      } else if (effectivePrimary != null) {
        await onCreate({ projectIds: [...selected], primaryProjectId: effectivePrimary, title: title.trim() || undefined });
      }
      onOpenChange(false);
      reset();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('chat:global.newTitle')}</DialogTitle>
          <DialogDescription>{t('chat:global.newDescription')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 min-w-0">
          <Input
            placeholder={t('chat:global.titlePlaceholder')}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={80}
          />

          <Tabs value={mode} onValueChange={(v) => setMode(v as 'new' | 'reuse')}>
            <TabsList className="w-full">
              <TabsTrigger value="new" className="flex-1">{t('chat:global.tabNew')}</TabsTrigger>
              <TabsTrigger value="reuse" className="flex-1">{t('chat:global.tabReuse')}</TabsTrigger>
            </TabsList>

            <TabsContent value="new" className="space-y-3 min-w-0">
              <div className="flex items-center gap-2">
                <div className="relative flex-1 min-w-0">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    className="pl-7"
                    placeholder={t('chat:global.searchProjects')}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={pickFolder}
                  disabled={picking}
                  className="shrink-0 gap-1.5"
                  title={t('chat:global.addFolderHint')}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  {t('chat:global.addFolder')}
                </Button>
              </div>

              <div className="max-h-56 w-full overflow-y-auto overflow-x-hidden rounded border divide-y">
                {filtered.length === 0 && (
                  <div className="px-3 py-4 text-xs text-muted-foreground">{t('chat:global.noProjects')}</div>
                )}
                {filtered.map((p) => {
                  const isSel = selected.has(p.id);
                  const isPrimary = effectivePrimary === p.id;
                  return (
                    <div
                      key={p.id}
                      className={cn('flex w-full min-w-0 items-center gap-2 px-2 py-1.5 text-xs', isSel && 'bg-accent/50')}
                    >
                      <input
                        type="checkbox"
                        checked={isSel}
                        onChange={() => toggle(p.id)}
                        className="h-3.5 w-3.5 shrink-0"
                        aria-label={p.name}
                      />
                      <button type="button" className="flex-1 min-w-0 text-left" onClick={() => toggle(p.id)}>
                        <div className="font-medium truncate">{p.name}</div>
                        <div className="text-[10px] text-muted-foreground truncate font-mono">{p.root_path}</div>
                      </button>
                      {isSel && (
                        <button
                          type="button"
                          onClick={() => setPrimaryId(p.id)}
                          title={t('chat:global.markPrimary')}
                          className={cn('shrink-0 p-1 rounded hover:bg-muted', isPrimary ? 'text-amber-500' : 'text-muted-foreground')}
                          aria-pressed={isPrimary}
                        >
                          <Star className={cn('h-3.5 w-3.5', isPrimary && 'fill-current')} />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              <p className="text-[11px] text-muted-foreground">{t('chat:global.primaryHint')}</p>
            </TabsContent>

            <TabsContent value="reuse" className="space-y-3 min-w-0">
              <div className="max-h-56 w-full overflow-y-auto overflow-x-hidden rounded border divide-y">
                {(workspaces ?? []).length === 0 && (
                  <div className="px-3 py-4 text-xs text-muted-foreground">{t('chat:global.noWorkspaces')}</div>
                )}
                {(workspaces ?? []).map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => setReuseId(w.id)}
                    className={cn(
                      'flex w-full min-w-0 items-center gap-2 px-2 py-2 text-xs text-left',
                      reuseId === w.id && 'bg-accent/60',
                    )}
                  >
                    <Boxes className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="flex-1 min-w-0 truncate font-medium">{w.label}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {t('chat:global.sessionsCount', { count: w.sessionCount })}
                    </span>
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">{t('chat:global.reuseHint')}</p>
            </TabsContent>
          </Tabs>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('common:actions.cancel')}
          </Button>
          <Button onClick={submit} disabled={!canCreate}>
            {t('common:actions.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
