/**
 * Session Drive panel — the single coder session's durable working memory.
 * Four tabs over one aggregate fetch (`GET /api/coder/sessions/:id/drive`):
 *
 *   - Map           — files read vs changed (guide files)
 *   - Memory        — durable notes (remember tool), survive compaction
 *   - Investigations — auto-captured sub-agent explorations (this session)
 *   - Plans         — submitted plan + task statuses
 *
 * Headless view (mirrors ToolStatsView): fetches when `active`, refetches on
 * a tick. Rendered inside `PanelChrome` by `RightPanelHost`, so it owns no
 * outer header/close — just a compact tab bar.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Compass, FolderTree, NotebookPen, RefreshCw, Telescope } from 'lucide-react';
import { apiBaseUrl } from '../../lib/api-client.js';
import { Button } from '../../components/ui/button.js';
import { cn } from '../../lib/utils.js';
import { DriveMapTab } from './drive/DriveMapTab.js';
import { DriveNotesTab } from './drive/DriveNotesTab.js';
import { DriveInvestigationsTab } from './drive/DriveInvestigationsTab.js';
import { DrivePlansTab } from './drive/DrivePlansTab.js';
import type { DriveAggregate, DriveTab } from './drive/types.js';

const TABS: Array<{ id: DriveTab; icon: typeof Compass; labelKey: string; fallback: string }> = [
  { id: 'map', icon: FolderTree, labelKey: 'drive.tabMap', fallback: 'Map' },
  { id: 'memory', icon: NotebookPen, labelKey: 'drive.tabNotes', fallback: 'Notes' },
  { id: 'investigations', icon: Telescope, labelKey: 'drive.tabInvestigations', fallback: 'Investigations' },
  { id: 'plans', icon: Compass, labelKey: 'drive.tabPlans', fallback: 'Plans' },
];

export function SessionDriveView({ sessionId, active }: { sessionId: string; active: boolean }) {
  const { t } = useTranslation('chat');
  const [tab, setTab] = useState<DriveTab>('map');
  const [data, setData] = useState<DriveAggregate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`${apiBaseUrl()}/api/coder/sessions/${sessionId}/drive`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as DriveAggregate;
      })
      .then((body) => !cancelled && setData(body))
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [active, sessionId, tick]);

  const refetch = () => setTick((n) => n + 1);

  // Live updates: the agent's `remember` / auto-captured investigations emit
  // `session_drive_changed` over SSE, bridged to this DOM event in handlers.ts.
  useEffect(() => {
    if (!active) return;
    const onChanged = (e: Event): void => {
      const detail = (e as CustomEvent).detail as { sessionId?: string } | undefined;
      if (detail?.sessionId === sessionId) setTick((n) => n + 1);
    };
    window.addEventListener('coder:drive_changed', onChanged);
    return () => window.removeEventListener('coder:drive_changed', onChanged);
  }, [active, sessionId]);
  const counts: Record<DriveTab, number> = {
    map: data ? data.fileMap.read.length + data.fileMap.changed.length : 0,
    memory: data?.memory.length ?? 0,
    investigations: data?.investigations.length ?? 0,
    plans: (data?.plans.length ?? 0) + (data?.tasks?.tasks.length ?? 0),
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-0.5 px-1.5 py-1 border-b shrink-0">
        {TABS.map(({ id, icon: Icon, labelKey, fallback }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              'flex items-center gap-1 rounded px-1.5 py-1 text-[11px] transition-colors',
              tab === id ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted',
            )}
            title={t(`chat:${labelKey}`, fallback)}
          >
            <Icon className="h-3.5 w-3.5" />
            {counts[id] > 0 && <span className="tabular-nums">{counts[id]}</span>}
          </button>
        ))}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-6 w-6 p-0"
          onClick={refetch}
          disabled={loading}
          title={t('drive.refresh', 'Refresh')}
        >
          <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
        </Button>
      </div>

      {error && (
        <div className="flex items-start gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive shrink-0">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        {!data && loading && <div className="text-xs text-muted-foreground">{t('drive.loading', 'Loading…')}</div>}
        {data && tab === 'map' && <DriveMapTab fileMap={data.fileMap} />}
        {data && tab === 'memory' && <DriveNotesTab sessionId={sessionId} memory={data.memory} onChanged={refetch} />}
        {data && tab === 'investigations' && <DriveInvestigationsTab investigations={data.investigations} />}
        {data && tab === 'plans' && <DrivePlansTab plans={data.plans} tasks={data.tasks} />}
      </div>
    </div>
  );
}
