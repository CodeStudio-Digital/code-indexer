import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, Check, Loader2, MessageSquare, Pencil, Plus, Search, X } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { WorkbenchPanelHeader } from '../../components/workbench/index.js';
import { useConfirm, useNotify } from '../../components/ui/dialog-provider.js';
import { NewFrontDialog } from './NewFrontDialog.js';
import type { CompanySession } from '@mcp/company-contracts';

interface CompanySessionsSidebarProps {
  /** The company's root session, displayed as "Main". */
  parent: CompanySession;
  /** Active sub-sessions (children of the parent). */
  children: CompanySession[];
  /** Equals `parent.id` when Main is active. */
  activeSessionId: string | null;
  query: string;
  onQueryChange: (query: string) => void;
  onClose: () => void;
  onSelect: (sessionId: string) => void;
  onCreate: (name: string) => Promise<CompanySession | null> | CompanySession | null;
  onArchive: (childId: string) => Promise<boolean> | boolean;
  /** Rename either a child OR the parent (uses sessionId, not childId). */
  onRename: (sessionId: string, name: string) => Promise<boolean> | boolean;
}

/** Company navigation only; execution remains isolated in the selected session. */
export function CompanySessionsSidebar({
  parent,
  children,
  activeSessionId,
  query,
  onQueryChange,
  onClose,
  onSelect,
  onCreate,
  onArchive,
  onRename,
}: CompanySessionsSidebarProps) {
  const { t } = useTranslation('agents');
  const confirm = useConfirm();
  const notify = useNotify();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState('');
  /** Sessions whose mutation (rename/archive) is currently in flight. */
  const [pending, setPending] = useState<Set<string>>(new Set());
  const mutations = useRef(new Set<string>());

  function markPending(id: string, on: boolean) {
    if (on) mutations.current.add(id);
    else mutations.current.delete(id);
    setPending((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function commitRename(sessionId: string) {
    if (mutations.current.has(sessionId)) return;
    const trimmed = draftLabel.trim();
    if (!trimmed) {
      setRenamingId(null);
      return;
    }
    const isParent = sessionId === parent.id;
    const session = isParent ? parent : children.find((c) => c.id === sessionId);
    if (!session || session.name === trimmed) {
      setRenamingId(null);
      return;
    }

    markPending(sessionId, true);
    try {
      const ok = await onRename(sessionId, trimmed);
      if (!ok) {
        await notify({
          title: t('fronts.rename_failed_title', 'Could not rename'),
          description: t('fronts.rename_failed_desc', 'The server rejected the rename. Please try again.'),
          variant: 'warning',
        });
      } else {
        setRenamingId(null);
      }
    } catch (e) {
      console.error('[CompanySessionsSidebar] rename failed:', e);
      await notify({
        title: t('fronts.rename_failed_title', 'Could not rename'),
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    } finally {
      markPending(sessionId, false);
    }
  }

  async function handleArchive(e: React.MouseEvent, child: CompanySession) {
    e.stopPropagation();
    if (mutations.current.has(child.id)) return;
    const ok = await confirm({
      title: t('fronts.confirm_archive_title', 'Archive front?'),
      description: t(
        'fronts.confirm_archive_desc',
        'Archive session "{{label}}"? It will leave the active sessions list.',
        { label: child.name },
      ),
      confirmLabel: t('fronts.archive', 'Archive front'),
      variant: 'warning',
    });
    if (!ok) return;
    markPending(child.id, true);
    try {
      const success = await onArchive(child.id);
      if (!success) {
        await notify({
          title: t('fronts.archive_failed_title', 'Could not archive'),
          description: t('fronts.archive_failed_desc', 'The server rejected the request.'),
          variant: 'warning',
        });
      }
    } catch (err) {
      console.error('[CompanySessionsSidebar] archive failed:', err);
      await notify({
        title: t('fronts.archive_failed_title', 'Could not archive'),
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      });
    } finally {
      markPending(child.id, false);
    }
  }

  async function handleCreate(name: string) {
    setCreating(true);
    try {
      const created = await onCreate(name);
      if (!created) {
        await notify({
          title: t('fronts.create_failed_title', 'Could not create front'),
          description: t('fronts.create_failed_desc', 'The server rejected the request.'),
          variant: 'warning',
        });
        return false;
      }
      onQueryChange('');
      return true;
    } catch (e) {
      console.error('[CompanySessionsSidebar] create failed:', e);
      await notify({
        title: t('fronts.create_failed_title', 'Could not create front'),
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
      return false;
    } finally {
      setCreating(false);
    }
  }

  function handleSelect(sessionId: string) {
    // Defensive: a stale row reference (e.g. between an archive request
    // and its server response) would route the stream hook at a deleted
    // session. Verify the id still exists locally before committing.
    const exists = sessionId === parent.id || children.some((c) => c.id === sessionId);
    if (!exists) return;
    onSelect(sessionId);
  }

  const sessions: Array<{ session: CompanySession; isParent: boolean; label: string }> = [
    { session: parent, isParent: true, label: t('fronts.main', 'Main') },
    ...children.map((c) => ({ session: c, isParent: false, label: c.name })),
  ];
  const search = query.trim().toLocaleLowerCase();
  const filtered = sessions.filter(({ label }) => label.toLocaleLowerCase().includes(search));
  const actionClass = 'grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-[var(--workbench-hover)] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40';

  return (
    <>
      <aside className="flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-surface)]" aria-label={t('fronts.sidebarLabel')}>
        <WorkbenchPanelHeader
          title={t('sessions')}
          icon={MessageSquare}
          onClose={onClose}
          closeLabel={t('fronts.closeList')}
          actions={
            <button type="button" className={actionClass} aria-label={t('fronts.new')} title={t('fronts.new')} disabled={creating} onClick={() => setDialogOpen(true)}>
              {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            </button>
          }
        />
        <div className="space-y-2 border-b border-[var(--workbench-border)] px-2 py-2">
          <div className="flex min-w-0 items-center justify-between gap-2 text-[11px]">
            <span className="truncate font-medium" title={parent.name}>{parent.name}</span>
            <span className="shrink-0 text-[10px] text-muted-foreground">{t('fronts.sessionCount', { count: sessions.length })}</span>
          </div>
          <label className="flex h-7 items-center gap-1.5 rounded border border-[var(--workbench-border)] bg-[var(--workbench-canvas)] px-2 text-muted-foreground focus-within:border-[var(--workbench-focus)]">
            <Search className="h-3.5 w-3.5 shrink-0" />
            <input value={query} onChange={(event) => onQueryChange(event.target.value)} aria-label={t('fronts.filter')} placeholder={t('fronts.filter')} className="min-w-0 flex-1 bg-transparent text-[11px] text-foreground outline-none placeholder:text-muted-foreground" />
          </label>
        </div>
        <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto p-1.5" aria-label={t('fronts.navigationLabel', { company: parent.name })}>
          {filtered.length === 0 && <p className="px-3 py-8 text-center text-xs text-muted-foreground">{t('fronts.noMatches')}</p>}
          {filtered.map(({ session, isParent, label }) => {
          const active = session.id === activeSessionId;
          const isPending = pending.has(session.id);
          const isRenaming = renamingId === session.id;
          return (
            <div
              key={session.id}
              className={cn(
                'group relative flex min-w-0 items-center rounded-md border-l-2 transition-colors',
                active ? 'border-primary bg-[var(--workbench-active)]' : 'border-transparent hover:bg-[var(--workbench-hover)]',
                isPending && 'opacity-60',
              )}
            >
              {isRenaming ? (
                <form className="flex min-w-0 flex-1 items-center gap-1 p-2" onSubmit={(event) => { event.preventDefault(); void commitRename(session.id); }}>
                  <input
                    type="text"
                    autoFocus
                    disabled={isPending}
                    aria-label={t('fronts.rename')}
                    className="min-w-0 flex-1 rounded border border-[var(--workbench-border)] bg-[var(--workbench-canvas)] px-1.5 py-1 text-xs outline-none focus:border-[var(--workbench-focus)]"
                    value={draftLabel}
                    onChange={(event) => setDraftLabel(event.target.value)}
                    onKeyDown={(event) => { if (event.key === 'Escape' && !isPending) { event.preventDefault(); setRenamingId(null); } }}
                  />
                  <button type="submit" className={actionClass} aria-label={t('fronts.saveName')} disabled={isPending || !draftLabel.trim()}>
                    {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                  </button>
                  <button type="button" className={actionClass} aria-label={t('common.cancel')} disabled={isPending} onClick={() => setRenamingId(null)}><X className="h-3.5 w-3.5" /></button>
                </form>
              ) : (
                <>
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-start gap-2 rounded py-2.5 pl-2 pr-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    title={label}
                    aria-label={label}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => handleSelect(session.id)}
                    onDoubleClick={() => { if (!isParent && !isPending) { setRenamingId(session.id); setDraftLabel(label); } }}
                  >
                    <MessageSquare className={cn('mt-0.5 h-4 w-4 shrink-0', active ? 'text-primary' : 'text-muted-foreground')} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">{label}</span>
                      <span className={cn('mt-1 flex items-center gap-1.5 text-[10px]', session.status === 'error' ? 'text-red-400' : 'text-muted-foreground')}>
                        {isPending ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : session.status === 'running' && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />}
                        {t(`status.${session.status}`, session.status)}
                      </span>
                    </span>
                  </button>
                  {!isParent && <div className="flex shrink-0 pr-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
                    <button type="button" className={actionClass} disabled={isPending} title={t('fronts.rename')} aria-label={t('fronts.renameNamed', { name: label })} onClick={() => { setRenamingId(session.id); setDraftLabel(label); }}><Pencil className="h-3 w-3" /></button>
                    <button type="button" className={actionClass} disabled={isPending} title={t('fronts.archive')} aria-label={t('fronts.archiveNamed', { name: label })} onClick={(event) => void handleArchive(event, session)}><Archive className="h-3 w-3" /></button>
                  </div>}
                </>
              )}
            </div>
          );
        })}
        </nav>
      </aside>
      {dialogOpen && (
        <NewFrontDialog
          onClose={() => setDialogOpen(false)}
          onCreate={handleCreate}
        />
      )}
    </>
  );
}
