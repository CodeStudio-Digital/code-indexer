import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { Button } from '../../components/ui/button.js';
import { NewFrontDialog } from './NewFrontDialog.js';
import type { CompanySession } from '@mcp/company/types.js';

interface FrontTabsBarProps {
  /** The root session — surfaces as the "Main" tab. */
  parent: CompanySession;
  /** Active sub-sessions (children of the parent). */
  children: CompanySession[];
  /** Currently-selected tab session id. Equals `parent.id` when Main is active. */
  activeSessionId: number | null;
  onSelect: (sessionId: number) => void;
  onCreate: (name: string) => Promise<CompanySession | null> | CompanySession | null;
  onArchive: (childId: number) => Promise<boolean> | boolean;
  onRename: (childId: number, name: string) => Promise<boolean> | boolean;
}

/**
 * Tab bar over a session and its sub-sessions (migration 067). The
 * parent shows up as the leftmost "Main" tab; non-archived children
 * follow in id order. Each tab is a real `CompanySession.id` — the
 * dashboard's `CompanySessionView` re-mounts `useCompanyStream` on
 * the active id, so switching tabs gets a clean isolated view of
 * board / agents / prompts for THAT sub-session.
 *
 * Inline-rename: double-click a child tab's label.
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
  const [dialogOpen, setDialogOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [draftLabel, setDraftLabel] = useState('');

  async function commitRename(childId: number) {
    const trimmed = draftLabel.trim();
    setRenamingId(null);
    if (!trimmed) return;
    const child = children.find((c) => c.id === childId);
    if (!child || child.name === trimmed) return;
    await onRename(childId, trimmed);
  }

  async function handleArchive(e: React.MouseEvent, child: CompanySession) {
    e.stopPropagation();
    const confirmed = window.confirm(
      t('fronts.confirm_archive', 'Archive front "{{label}}"? Its agents will stop and the tab disappears.', { label: child.name }),
    );
    if (!confirmed) return;
    await onArchive(child.id);
  }

  // Render order: parent first (Main), then children by id.
  const tabs: Array<{ session: CompanySession; isParent: boolean; label: string }> = [
    { session: parent, isParent: true, label: parent.name || t('fronts.main', 'Main') },
    ...children.map((c) => ({ session: c, isParent: false, label: c.name })),
  ];

  return (
    <>
      <div className="flex items-center gap-1 border-b px-3 py-1.5 overflow-x-auto bg-muted/30">
        {tabs.map(({ session, isParent, label }) => {
          const active = session.id === activeSessionId;
          return (
            <button
              key={session.id}
              type="button"
              onClick={() => onSelect(session.id)}
              className={cn(
                'group inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-sm transition-colors whitespace-nowrap',
                active
                  ? 'bg-background border shadow-sm'
                  : 'hover:bg-background/60 text-muted-foreground',
              )}
              title={label}
              onDoubleClick={(e) => {
                if (isParent) return;
                e.stopPropagation();
                setRenamingId(session.id);
                setDraftLabel(label);
              }}
            >
              {renamingId === session.id ? (
                <input
                  type="text"
                  autoFocus
                  className="bg-transparent border-b border-foreground/40 focus:outline-none text-sm font-medium w-32"
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
              {session.status === 'running' && (
                <span className="inline-block size-1.5 rounded-full bg-emerald-500" aria-label="running" />
              )}
              {!isParent && (
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
        >
          <Plus className="size-3.5" />
          <span className="text-xs">{t('fronts.new', 'New front')}</span>
        </Button>
      </div>
      {dialogOpen && (
        <NewFrontDialog
          onClose={() => setDialogOpen(false)}
          onCreate={async (name) => { await onCreate(name); }}
        />
      )}
    </>
  );
}
