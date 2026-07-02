/**
 * Agent Memory curation list — the human feedback loop over the LIVE
 * `agent_memory` store (the one the agent actually reads): pin (star →
 * importance 0.95, tops the turn-1 index and skips relevance floors),
 * one-click reversible archive, and restore from the collapsed archived tail.
 * Sits below AgentMemoryHealthCard on the project Memory surface.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Star, Archive, Undo2, ChevronRight } from 'lucide-react';
import { apiPost, apiPut, useApi } from '../../../hooks/useApi.js';
import { cn } from '../../../lib/utils.js';

interface AgentMemoryRow {
  id: number;
  name: string;
  description: string;
  type: string;
  scope: string;
  content: string;
  source: string;
  importance: number;
  access_count: number;
  archived_at: string | null;
  archived_reason: string | null;
}

const PIN_THRESHOLD = 0.9;
const PIN_IMPORTANCE = 0.95;
const UNPIN_IMPORTANCE = 0.5;

const TYPE_COLORS: Record<string, string> = {
  preference: 'bg-amber-500/15 text-amber-600 dark:text-amber-300',
  convention: 'bg-sky-500/15 text-sky-600 dark:text-sky-300',
  gotcha: 'bg-red-500/15 text-red-600 dark:text-red-300',
  decision: 'bg-violet-500/15 text-violet-600 dark:text-violet-300',
  procedure: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300',
};

export function AgentMemoryList({ projectId }: { projectId: number }) {
  const { t } = useTranslation('projects');
  const { data, refetch } = useApi<AgentMemoryRow[]>(`/projects/${projectId}/agent-memory`);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const rows = data ?? [];
  const live = rows.filter((r) => r.archived_at === null);
  const archived = rows.filter((r) => r.archived_at !== null);
  if (rows.length === 0) return null;

  const act = async (id: number, fn: () => Promise<unknown>) => {
    setBusyId(id);
    setActionError(null);
    try {
      await fn();
      refetch();
    } catch (e) {
      // The restore route intentionally 409s on a live name collision — the
      // user must see why the click "did nothing".
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const togglePin = (r: AgentMemoryRow) =>
    act(r.id, () => apiPut(`/agent-memory/${r.id}/importance`, {
      importance: r.importance >= PIN_THRESHOLD ? UNPIN_IMPORTANCE : PIN_IMPORTANCE,
    }));

  const Row = ({ r, isArchived }: { r: AgentMemoryRow; isArchived?: boolean }) => (
    <div className={cn('flex items-start gap-1.5 rounded border px-2 py-1', isArchived && 'opacity-60')}>
      <span className={cn(
        'px-1 py-0.5 rounded text-[9px] font-medium shrink-0',
        TYPE_COLORS[r.type] ?? 'bg-muted text-muted-foreground',
      )}>
        {r.type}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-medium truncate" title={r.name}>{r.name}</div>
        <div className="text-[10px] text-muted-foreground line-clamp-2" title={r.content}>
          {r.description || r.content}
        </div>
      </div>
      <span className="text-[9px] text-muted-foreground shrink-0" title={t('memory.list.accessTip')}>
        ×{r.access_count}
      </span>
      {!isArchived ? (
        <>
          <button
            type="button"
            disabled={busyId === r.id}
            onClick={() => togglePin(r)}
            title={r.importance >= PIN_THRESHOLD ? t('memory.list.unpin') : t('memory.list.pin')}
            className="p-1 rounded hover:bg-muted disabled:opacity-50"
          >
            <Star className={cn(
              'h-3 w-3',
              r.importance >= PIN_THRESHOLD ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground',
            )} />
          </button>
          <button
            type="button"
            disabled={busyId === r.id}
            onClick={() => act(r.id, () => apiPost(`/agent-memory/${r.id}/archive`, {}))}
            title={t('memory.list.archive')}
            className="p-1 rounded hover:bg-muted text-muted-foreground disabled:opacity-50"
          >
            <Archive className="h-3 w-3" />
          </button>
        </>
      ) : (
        <button
          type="button"
          disabled={busyId === r.id}
          onClick={() => act(r.id, () => apiPost(`/agent-memory/${r.id}/restore`, {}))}
          title={t('memory.list.restore')}
          className="p-1 rounded hover:bg-muted text-muted-foreground disabled:opacity-50"
        >
          <Undo2 className="h-3 w-3" />
        </button>
      )}
    </div>
  );

  return (
    <div className="px-3 py-2 space-y-1 border-b shrink-0">
      <div className="text-[10px] font-medium text-muted-foreground">
        {t('memory.list.title', { count: live.length })}
      </div>
      {actionError && (
        <div className="text-[10px] text-red-500 break-all" role="alert">{actionError}</div>
      )}
      <div className="space-y-1 max-h-56 overflow-y-auto">
        {live.map((r) => <Row key={r.id} r={r} />)}
      </div>
      {archived.length > 0 && (
        <details className="pt-1">
          <summary className="flex items-center gap-1 cursor-pointer select-none text-[10px] text-muted-foreground">
            <ChevronRight className="h-3 w-3" />
            {t('memory.list.archived', { count: archived.length })}
          </summary>
          <div className="space-y-1 mt-1 max-h-40 overflow-y-auto">
            {archived.map((r) => <Row key={r.id} r={r} isArchived />)}
          </div>
        </details>
      )}
    </div>
  );
}
