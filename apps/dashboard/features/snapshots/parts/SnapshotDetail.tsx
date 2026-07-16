/**
 * Right-pane viewer for a single snapshot. Header shows category +
 * title + meta + actions (Edit / Copy / Delete). Body is a Tabs widget
 * with three views:
 *
 *  - View: markdown rendered (reuses the chat `<Markdown />`).
 *  - Raw: monospaced source — easy to paste back into the agent or LLM.
 *  - History: list of previous versions, each expandable.
 *
 * Lives independently of `SnapshotList` so the left pane never re-renders
 * when the user switches tabs.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Pencil, Star, Trash2 } from 'lucide-react';
import { formatDateTime } from '../../../lib/datetime.js';
import { Button } from '../../../components/ui/button.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../components/ui/tabs.js';
import { useApi } from '../../../hooks/useApi.js';
import { cn } from '../../../lib/utils.js';
import { Markdown } from '../../chat/messages/Markdown.js';
import {
  CATEGORY_COLORS,
  parseTags,
  type Snapshot,
  type SnapshotVersion,
} from '../snapshot-types.js';

interface SnapshotDetailProps {
  snapshot: Snapshot;
  onEdit: () => void;
  onDelete: () => void;
  /** Pin/unpin = importance boost (retrieval ranking + turn-1 index). */
  onTogglePin?: () => void;
}

export function SnapshotDetail({ snapshot, onEdit, onDelete, onTogglePin }: SnapshotDetailProps) {
  const { t } = useTranslation(['projects', 'common']);
  const [copied, setCopied] = useState(false);
  const tags = parseTags(snapshot.tags);
  const visibleTags = tags.filter((tag) => tag !== 'auto-generated');
  const isAuto = tags.includes('auto-generated');
  const pinned = (snapshot.importance ?? 0.5) >= 0.9;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(snapshot.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — surface in a toast if/when we wire one in */
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-card">
      {/* Header — chip + title + meta + actions */}
      <header className="px-3 py-2 border-b shrink-0 space-y-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={cn(
              'px-1.5 py-0.5 rounded text-[10px] font-medium capitalize shrink-0',
              CATEGORY_COLORS[snapshot.category] ?? CATEGORY_COLORS.note,
            )}
          >
            {snapshot.category}
          </span>
          <span className="text-sm font-semibold truncate flex-1">{snapshot.title}</span>
          {isAuto && (
            <span className="text-[9px] px-1 py-0.5 rounded bg-orange-500/15 text-orange-600 dark:text-orange-300 shrink-0">
              auto
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground min-w-0">
          <span className="truncate">
            {formatDateTime(snapshot.created_at)} · {snapshot.created_by}
            {snapshot.source ? ` · ${snapshot.source}` : ''}
            {typeof snapshot.importance === 'number'
              ? ` · imp ${snapshot.importance.toFixed(2)}`
              : ''}
            {typeof snapshot.access_count === 'number' && snapshot.access_count > 0
              ? ` · ${snapshot.access_count}× recalled`
              : ''}
          </span>
          <div className="ml-auto flex items-center gap-0.5 shrink-0">
            {onTogglePin && (
              <Button
                variant="ghost"
                size="sm"
                className={cn('h-6 px-2 gap-1 text-[11px]', pinned && 'text-amber-500 hover:text-amber-500')}
                onClick={onTogglePin}
                title={pinned ? t('projects:memory.actions.unpin') : t('projects:memory.actions.pin')}
              >
                <Star className={cn('h-3 w-3', pinned && 'fill-current')} />
                {pinned ? t('projects:memory.actions.unpin') : t('projects:memory.actions.pin')}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 gap-1 text-[11px]"
              onClick={handleCopy}
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copied
                ? t('common:actions.copied', 'Copied')
                : t('common:actions.copy', 'Copy')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 gap-1 text-[11px]"
              onClick={onEdit}
            >
              <Pencil className="h-3 w-3" />
              {t('common:actions.edit', 'Edit')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 gap-1 text-[11px] text-destructive hover:text-destructive"
              onClick={onDelete}
            >
              <Trash2 className="h-3 w-3" />
              {t('common:actions.delete')}
            </Button>
          </div>
        </div>
        {visibleTags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {visibleTags.map((tag) => (
              <span
                key={tag}
                className="px-1.5 py-0.5 text-[9px] rounded bg-muted text-muted-foreground"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </header>

      <SnapshotTabs snapshot={snapshot} />
    </div>
  );
}

function SnapshotTabs({ snapshot }: { snapshot: Snapshot }) {
  const { t } = useTranslation(['projects', 'common']);
  return (
    <Tabs defaultValue="view" className="flex-1 flex flex-col min-h-0">
      <TabsList className="w-full justify-start rounded-none border-b bg-transparent h-8 shrink-0 px-2">
        <TabsTrigger value="view" className="text-[11px] h-7">
          {t('projects:snapshots.tabs.view', 'View')}
        </TabsTrigger>
        <TabsTrigger value="raw" className="text-[11px] h-7">
          {t('projects:snapshots.tabs.raw', 'Raw')}
        </TabsTrigger>
        <TabsTrigger value="history" className="text-[11px] h-7">
          {t('projects:snapshots.tabs.history', 'History')}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="view" className="flex-1 min-h-0 overflow-y-auto px-4 py-3 mt-0">
        <Markdown text={snapshot.content} />
      </TabsContent>
      <TabsContent value="raw" className="flex-1 min-h-0 overflow-y-auto mt-0">
        <pre className="px-4 py-3 text-xs font-mono whitespace-pre-wrap break-words">
          {snapshot.content}
        </pre>
      </TabsContent>
      <TabsContent value="history" className="flex-1 min-h-0 overflow-y-auto px-3 py-2 mt-0">
        <HistoryList snapshotId={snapshot.id} />
      </TabsContent>
    </Tabs>
  );
}

function HistoryList({ snapshotId }: { snapshotId: number }) {
  const { t } = useTranslation(['projects', 'common']);
  const { data: history, loading } = useApi<SnapshotVersion[]>(
    `/snapshots/${snapshotId}/history`,
  );

  if (loading) {
    return <div className="text-[11px] text-muted-foreground">{t('common:actions.loading')}</div>;
  }
  if (!history || history.length === 0) {
    return (
      <div className="text-[11px] text-muted-foreground text-center py-6">
        {t('projects:snapshots.noHistory', 'No previous versions.')}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {history.map((v) => (
        <details key={v.id} className="rounded border bg-muted/30">
          <summary className="cursor-pointer px-2 py-1.5 text-[11px] hover:bg-muted/60">
            <span className="font-medium">v{v.version}</span>
            <span className="text-muted-foreground ml-2">
              {formatDateTime(v.updated_at)} · {v.updated_by}
            </span>
          </summary>
          <div className="px-2 py-2 border-t text-[11px] font-mono whitespace-pre-wrap break-words">
            {v.content}
          </div>
        </details>
      ))}
    </div>
  );
}
