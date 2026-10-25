/**
 * Context tabs share the session drive for file history, notes and investigations.
 * Attachments and chapters keep their own APIs and mount only when selected.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, BookOpen, FolderTree, NotebookPen, Paperclip, RefreshCw, Telescope } from 'lucide-react';
import { apiBaseUrl } from '../../lib/api-client.js';
import { Button } from '../../components/ui/button.js';
import { cn } from '../../lib/utils.js';
import { DriveMapTab } from './drive/DriveMapTab.js';
import { DriveNotesTab } from './drive/DriveNotesTab.js';
import { DriveInvestigationsTab } from './drive/DriveInvestigationsTab.js';
import { SessionFilesTab } from './drive/SessionFilesTab.js';
import type { DriveAggregate, DriveTab } from './drive/types.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';

const TABS: Array<{ id: DriveTab; icon: typeof FolderTree; labelKey: string; fallback: string }> = [
  { id: 'attachments', icon: Paperclip, labelKey: 'context.attachments', fallback: 'Attachments' },
  { id: 'files', icon: FolderTree, labelKey: 'sessionFiles.title', fallback: 'Session files' },
  { id: 'map', icon: FolderTree, labelKey: 'drive.tabMap', fallback: 'Map' },
  { id: 'memory', icon: NotebookPen, labelKey: 'drive.tabNotes', fallback: 'Notes' },
  { id: 'investigations', icon: Telescope, labelKey: 'drive.tabInvestigations', fallback: 'Investigations' },
  { id: 'chapters', icon: BookOpen, labelKey: 'rightRail.chapters', fallback: 'Chapters' },
];

export function SessionDriveView({ sessionId, active, initialTab = 'attachments', attachments, chapters }: {
  sessionId: string; active: boolean; initialTab?: DriveTab; attachments: ReactNode; chapters: ReactNode;
}) {
  const { t } = useTranslation('chat');
  const [tab, setTab] = useState<DriveTab>(initialTab);
  const [data, setData] = useState<DriveAggregate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const needsDrive = active && ['map', 'memory', 'investigations'].includes(tab);
  useEffect(() => { setTab(initialTab); setData(null); }, [sessionId, initialTab]);

  useEffect(() => {
    if (!needsDrive) return;
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
  }, [needsDrive, sessionId, tick]);

  const refetch = () => setTick((n) => n + 1);

  // Live updates: the agent's `remember` / auto-captured investigations emit
  // `session_drive_changed` over SSE, bridged to this DOM event in handlers.ts.
  useEffect(() => {
    if (!needsDrive) return;
    const onChanged = (e: Event): void => {
      const detail = (e as CustomEvent).detail as { sessionId?: string } | undefined;
      if (detail?.sessionId === sessionId) setTick((n) => n + 1);
    };
    window.addEventListener('coder:drive_changed', onChanged);
    return () => window.removeEventListener('coder:drive_changed', onChanged);
  }, [needsDrive, sessionId]);
  const counts: Partial<Record<DriveTab, number>> = {
    map: data ? data.fileMap.read.length + data.fileMap.changed.length : 0,
    memory: data?.memory.length ?? 0,
    investigations: data?.investigations.length ?? 0,
  };

  return (
    <Tabs value={tab} onValueChange={(value) => setTab(value as DriveTab)} className="flex flex-col h-full min-h-0">
      <TabsList aria-label={t('rightRail.context')} className="flex h-auto w-full shrink-0 flex-wrap justify-start gap-1 rounded-none border-b bg-transparent p-2">
        {TABS.map(({ id, icon: Icon, labelKey, fallback }) => (
          <TabsTrigger
            key={id}
            value={id}
            className={cn(
              'flex items-center gap-1 rounded px-1.5 py-1 text-[11px] transition-colors',
              tab === id ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted',
            )}
            title={t(`chat:${labelKey}`, fallback)}
            aria-label={t(`chat:${labelKey}`, fallback)}
          >
            <Icon className="h-3.5 w-3.5" />
            <span>{t(`chat:${labelKey}`, fallback)}</span>
            {(counts[id] ?? 0) > 0 && <span className="tabular-nums">{counts[id]}</span>}
          </TabsTrigger>
        ))}
        {needsDrive && <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-6 w-6 p-0"
          onClick={refetch}
          disabled={loading}
          title={t('drive.refresh', 'Refresh')}
        >
          <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
        </Button>}
      </TabsList>

      {needsDrive && error && (
        <div className="flex items-start gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive shrink-0">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <TabsContent value={tab} aria-label={t(`chat:${TABS.find((item) => item.id === tab)!.labelKey}`)} className="mt-0 flex-1 min-h-0 overflow-y-auto">
        {tab === 'attachments' && attachments}
        {tab === 'files' && <SessionFilesTab key={sessionId} sessionId={sessionId} />}
        {tab === 'chapters' && chapters}
        {needsDrive && <div className="p-3">
        {!data && loading && <div className="text-xs text-muted-foreground">{t('drive.loading', 'Loading…')}</div>}
        {data && tab === 'map' && <DriveMapTab fileMap={data.fileMap} />}
        {data && tab === 'memory' && <DriveNotesTab sessionId={sessionId} memory={data.memory} onChanged={refetch} />}
        {data && tab === 'investigations' && <DriveInvestigationsTab investigations={data.investigations} />}
        </div>}
      </TabsContent>
    </Tabs>
  );
}
