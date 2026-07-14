/**
 * Right-rail panel for the database client: query History (per connection) and
 * Saved queries (per project), wiring the existing CRUD routes. Click an item to
 * open it in a new query tab; copy or delete from the hover actions.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, Trash2, Copy, Clock, Bookmark } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import { copyText } from '../../../lib/clipboard.js';
import { confirm, toast } from '../../../components/ui/prompt-dialog.js';
import { SubTabs } from '../../api-client/SubTabs.js';
import * as api from '../api.js';
import type { DbQueryHistoryRow, DbSavedQuery } from '../types.js';

const STATUS_DOT: Record<string, string> = {
  ok: 'bg-emerald-500',
  error: 'bg-red-500',
  cancelled: 'bg-amber-500',
};

export function QueryAuxPanel({
  projectId,
  connectionId,
  refreshKey,
  onOpenQuery,
  view,
}: {
  projectId: number;
  connectionId: number | null;
  refreshKey: number;
  onOpenQuery: (sql: string) => void;
  /** When set, render one rail-owned view without the internal tab strip. */
  view?: 'history' | 'saved';
}) {
  const { t } = useTranslation('dbClient');
  const [tab, setTab] = useState<'history' | 'saved'>('history');
  const [history, setHistory] = useState<DbQueryHistoryRow[]>([]);
  const [saved, setSaved] = useState<DbSavedQuery[]>([]);
  const activeTab = view ?? tab;

  const loadHistory = useCallback(async () => {
    if (connectionId == null) {
      setHistory([]);
      return;
    }
    setHistory(await api.listHistory(projectId, connectionId).catch(() => []));
  }, [projectId, connectionId]);

  const loadSaved = useCallback(async () => {
    setSaved(await api.listSavedQueries(projectId).catch(() => []));
  }, [projectId]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory, refreshKey]);
  useEffect(() => {
    void loadSaved();
  }, [loadSaved, refreshKey]);

  const copy = async (sql: string): Promise<void> => {
    if (await copyText(sql)) toast.success(t('grid.copied'));
  };

  return (
    <div className="flex h-full flex-col bg-[var(--workbench-surface)]">
      {!view && (
        <SubTabs
          tabs={[
            { id: 'history', label: t('aux.history') },
            { id: 'saved', label: t('aux.saved'), badge: saved.length },
          ]}
          active={tab}
          onChange={setTab}
        />
      )}
      <div className="flex items-center gap-1 border-b px-2 py-0.5">
        <div className="flex-1" />
        <button
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          title={t('aux.refresh')}
          onClick={() => void (activeTab === 'history' ? loadHistory() : loadSaved())}
        >
          <RefreshCw className="h-3 w-3" />
        </button>
        {activeTab === 'history' && connectionId != null && history.length > 0 && (
          <button
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-red-400"
            title={t('aux.clear')}
            onClick={async () => {
              if (await confirm({ title: t('aux.clear'), description: t('aux.clearConfirm'), tone: 'destructive' })) {
                await api.clearHistory(projectId, connectionId).catch(() => void 0);
                void loadHistory();
              }
            }}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-auto py-1 text-xs">
        {activeTab === 'history' ? (
          history.length === 0 ? (
            <Empty label={t('aux.empty')} />
          ) : (
            history.map((h) => (
              <Item
                key={h.id}
                sql={h.sql}
                onOpen={() => onOpenQuery(h.sql)}
                onCopy={() => void copy(h.sql)}
                onDelete={async () => {
                  if (!(await confirm({
                    title: t('aux.deleteHistoryConfirm'),
                    confirmLabel: t('aux.delete'),
                    tone: 'destructive',
                  }))) return;
                  await api.deleteHistoryRow(projectId, h.id).catch(() => void 0);
                  void loadHistory();
                }}
                t={t}
                leading={<span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT[h.status] ?? 'bg-muted-foreground/40')} />}
                meta={h.row_count != null ? `${h.row_count} ${t('query.rows')}${h.duration_ms != null ? ` · ${h.duration_ms}${t('query.elapsed')}` : ''}` : (h.error_message ?? '')}
              />
            ))
          )
        ) : saved.length === 0 ? (
          <Empty label={t('aux.empty')} />
        ) : (
          saved.map((q) => (
            <Item
              key={q.id}
              sql={q.sql}
              title={q.name}
              onOpen={() => onOpenQuery(q.sql)}
              onCopy={() => void copy(q.sql)}
              onDelete={async () => {
                if (!(await confirm({
                  title: t('aux.deleteSavedConfirm', { name: q.name }),
                  confirmLabel: t('aux.delete'),
                  tone: 'destructive',
                }))) return;
                await api.deleteSavedQuery(projectId, q.id).catch(() => void 0);
                void loadSaved();
              }}
              t={t}
              leading={<Bookmark className="h-3 w-3 shrink-0 text-amber-400" />}
            />
          ))
        )}
      </div>
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-2 px-3 py-8 text-center text-muted-foreground">
      <Clock className="h-4 w-4 opacity-50" />
      <span className="text-[11px]">{label}</span>
    </div>
  );
}

function Item({
  sql,
  title,
  meta,
  leading,
  onOpen,
  onCopy,
  onDelete,
  t,
}: {
  sql: string;
  title?: string;
  meta?: string;
  leading: React.ReactNode;
  onOpen: () => void;
  onCopy: () => void;
  onDelete: () => void;
  t: (k: string) => string;
}) {
  return (
    <div className="group flex cursor-pointer items-start gap-1.5 px-2 py-1 hover:bg-muted/50" onClick={onOpen} title={sql}>
      <span className="mt-1">{leading}</span>
      <div className="min-w-0 flex-1">
        {title && <div className="truncate font-medium">{title}</div>}
        <div className="truncate font-mono text-[11px] text-muted-foreground">{sql}</div>
        {meta && <div className="truncate text-[10px] text-muted-foreground/70">{meta}</div>}
      </div>
      <button
        className="shrink-0 rounded p-0.5 text-muted-foreground/70 opacity-0 hover:text-foreground group-hover:opacity-100"
        title={t('aux.copy')}
        onClick={(e) => {
          e.stopPropagation();
          onCopy();
        }}
      >
        <Copy className="h-3 w-3" />
      </button>
      <button
        className="shrink-0 rounded p-0.5 text-muted-foreground/70 opacity-0 hover:text-red-400 group-hover:opacity-100"
        title={t('aux.delete')}
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}
