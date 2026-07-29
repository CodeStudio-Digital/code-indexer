import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Plus, X } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { Button } from '../../components/ui/button.js';
import { useConfirm, useNotify } from '../../components/ui/dialog-provider.js';
import { NewFrontDialog } from './NewFrontDialog.js';
import type { CompanySession } from '@mcp/company-contracts';

interface FrontTabsBarProps {
  /** The root session — surfaces as the "Main" tab. */
  parent: CompanySession;
  /** Active sub-sessions (children of the parent). */
  children: CompanySession[];
  /** Currently-selected tab session id. Equals `parent.id` when Main is active. */
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onCreate: (name: string) => Promise<CompanySession | null> | CompanySession | null;
  onArchive: (childId: string) => Promise<boolean> | boolean;
  /** Rename either a child OR the parent (uses sessionId, not childId). */
  onRename: (sessionId: string, name: string) => Promise<boolean> | boolean;
}

/**
 * Tab bar over a session and its sub-sessions (migration 067). The
 * parent shows up as the leftmost "Main" tab; non-archived children
 * follow in id order. Each tab is a real `CompanySession.id` — the
 * dashboard's `CompanySessionView` re-mounts `useCompanyStream` on
 * the active id, so switching tabs gets a clean isolated view of
 * board / agents / prompts for THAT sub-session.
 *
 * Inline-rename: double-click any tab (including the parent's "Main"
 * tab — backend supports renaming via `PATCH /sessions/:id`).
 *
 * The component awaits every mutation (rename/archive/create) before
 * reflecting the result, with spinners during the in-flight window
 * and toast-style notifications on error. The previous behavior cleared
 * the rename input immediately on submit, which let a slow round-trip
 * race against a fresh double-click and either drop the new name or
 * apply it to the wrong session.
 */
export function FrontTabsBar({
  parent,
  children,
  activeSessionId,
  onSelect,
  onCreate,
  onArchive,
  onRename,
}: FrontTabsBarProps) {
  const { t } = useTranslation('agents');
  const confirm = useConfirm();
  const notify = useNotify();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState('');
  /** Sessions whose mutation (rename/archive) is currently in flight. */
  const [pending, setPending] = useState<Set<string>>(new Set());

  function markPending(id: string, on: boolean) {
    setPending((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function commitRename(sessionId: string) {
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
      console.error('[FrontTabsBar] rename failed:', e);
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
    const ok = await confirm({
      title: t('fronts.confirm_archive_title', 'Archive front?'),
      description: t(
        'fronts.confirm_archive_desc',
        'Archive front "{{label}}"? Its agents will stop and the tab disappears.',
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
      console.error('[FrontTabsBar] archive failed:', err);
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
      }
    } catch (e) {
      console.error('[FrontTabsBar] create failed:', e);
      await notify({
        title: t('fronts.create_failed_title', 'Could not create front'),
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    } finally {
      setCreating(false);
    }
  }

  function handleSelect(sessionId: string) {
    // Defensive: a stale tab reference (e.g. between an archive request
    // and its server response) would route the stream hook at a deleted
    // session. Verify the id still exists locally before committing.
    const exists = sessionId === parent.id || children.some((c) => c.id === sessionId);
    if (!exists) return;
    onSelect(sessionId);
  }

  // Render order: parent first (Main), then the already-canonical child order.
  const tabs: Array<{ session: CompanySession; isParent: boolean; label: string }> = [
    { session: parent, isParent: true, label: parent.name || t('fronts.main', 'Main') },
    ...children.map((c) => ({ session: c, isParent: false, label: c.name })),
  ];

  return (
    <>
      <div className="flex items-center gap-1 border-b px-3 py-1.5 overflow-x-auto bg-muted/30">
        {tabs.map(({ session, isParent, label }) => {
          const active = session.id === activeSessionId;
          const isPending = pending.has(session.id);
          const isRenaming = renamingId === session.id;
          return (
            <button
              key={session.id}
              type="button"
              onClick={() => handleSelect(session.id)}
              className={cn(
                'group inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-sm transition-colors whitespace-nowrap',
                active
                  ? 'bg-background border shadow-sm'
                  : 'hover:bg-background/60 text-muted-foreground',
                isPending && 'opacity-60',
              )}
              title={label}
              onDoubleClick={(e) => {
                e.stopPropagation();
                setRenamingId(session.id);
                setDraftLabel(label);
              }}
            >
              {isRenaming ? (
                <input
                  type="text"
                  autoFocus
                  disabled={isPending}
                  className="bg-transparent border-b border-foreground/40 focus:outline-none text-sm font-medium w-32 disabled:opacity-60"
                  value={draftLabel}
                  onChange={(e) => setDraftLabel(e.target.value)}
                  onBlur={() => void commitRename(session.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void commitRename(session.id);
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      setRenamingId(null);
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="font-medium">{label}</span>
              )}
              {isPending && (
                <Loader2 className="size-3 animate-spin text-muted-foreground" aria-label="pending" />
              )}
              {!isPending && session.status === 'running' && (
                <span className="inline-block size-1.5 rounded-full bg-emerald-500" aria-label="running" />
              )}
              {!isParent && !isPending && (
                <span
                  role="button"
                  tabIndex={-1}
                  className={cn(
                    'inline-flex items-center justify-center rounded-sm p-0.5 text-muted-foreground/60 opacity-0 group-hover:opacity-100',
                    'hover:bg-muted hover:text-foreground',
                  )}
                  onClick={(e) => handleArchive(e, session)}
                  aria-label={t('fronts.archive', 'Archive front')}
                >
                  <X className="size-3" />
                </span>
              )}
            </button>
          );
        })}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-1 h-7 px-2 gap-1 text-muted-foreground"
          onClick={() => setDialogOpen(true)}
          disabled={creating}
        >
          {creating ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Plus className="size-3.5" />
          )}
          <span className="text-xs">{t('fronts.new', 'New front')}</span>
        </Button>
      </div>
      {dialogOpen && (
        <NewFrontDialog
          onClose={() => setDialogOpen(false)}
          onCreate={async (name) => {
            await handleCreate(name);
          }}
        />
      )}
    </>
  );
}
