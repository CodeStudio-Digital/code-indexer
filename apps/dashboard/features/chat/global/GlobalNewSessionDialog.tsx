import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Star, Search } from 'lucide-react';
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
import { useApi } from '../../../hooks/useApi.js';
import { cn } from '../../../lib/utils.js';

interface ProjectRow {
  id: number;
  name: string;
  root_path: string;
}

export interface GlobalNewSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (opts: { projectIds: number[]; primaryProjectId: number; title?: string }) => Promise<unknown> | void;
}

/**
 * Create a global (multi-project) session: pick 1+ projects, mark one as the
 * primary (the agent's native cwd). The rest become linked secondary roots the
 * agent can read and edit via `project: "<slug>"`.
 */
export function GlobalNewSessionDialog({ open, onOpenChange, onCreate }: GlobalNewSessionDialogProps) {
  const { t } = useTranslation(['chat', 'common']);
  const { data: projects } = useApi<ProjectRow[]>(open ? '/projects' : '');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [primaryId, setPrimaryId] = useState<number | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = projects ?? [];
    if (!q) return list;
    return list.filter((p) => p.name.toLowerCase().includes(q) || p.root_path.toLowerCase().includes(q));
  }, [projects, query]);

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
    setQuery('');
    setSelected(new Set());
    setPrimaryId(null);
    setTitle('');
  };

  const effectivePrimary = primaryId != null && selected.has(primaryId)
    ? primaryId
    : (selected.values().next().value ?? null);
  const canCreate = selected.size >= 1 && effectivePrimary != null && !busy;

  const submit = async () => {
    if (!canCreate || effectivePrimary == null) return;
    setBusy(true);
    try {
      await onCreate({
        projectIds: [...selected],
        primaryProjectId: effectivePrimary,
        title: title.trim() || undefined,
      });
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

        <div className="space-y-3">
          <Input
            placeholder={t('chat:global.titlePlaceholder')}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={80}
          />

          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              className="pl-7"
              placeholder={t('chat:global.searchProjects')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          <div className="max-h-64 overflow-auto rounded border divide-y">
            {filtered.length === 0 && (
              <div className="px-3 py-4 text-xs text-muted-foreground">{t('chat:global.noProjects')}</div>
            )}
            {filtered.map((p) => {
              const isSel = selected.has(p.id);
              const isPrimary = effectivePrimary === p.id;
              return (
                <div
                  key={p.id}
                  className={cn('flex items-center gap-2 px-2 py-1.5 text-xs', isSel && 'bg-accent/50')}
                >
                  <input
                    type="checkbox"
                    checked={isSel}
                    onChange={() => toggle(p.id)}
                    className="h-3.5 w-3.5 shrink-0"
                    aria-label={p.name}
                  />
                  <button
                    type="button"
                    className="flex-1 min-w-0 text-left"
                    onClick={() => toggle(p.id)}
                  >
                    <div className="font-medium truncate">{p.name}</div>
                    <div className="text-[10px] text-muted-foreground truncate font-mono">{p.root_path}</div>
                  </button>
                  {isSel && (
                    <button
                      type="button"
                      onClick={() => setPrimaryId(p.id)}
                      title={t('chat:global.markPrimary')}
                      className={cn(
                        'shrink-0 p-1 rounded hover:bg-muted',
                        isPrimary ? 'text-amber-500' : 'text-muted-foreground',
                      )}
                      aria-pressed={isPrimary}
                    >
                      <Star className={cn('h-3.5 w-3.5', isPrimary && 'fill-current')} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          <p className="text-[11px] text-muted-foreground">
            {t('chat:global.primaryHint')}
          </p>
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
