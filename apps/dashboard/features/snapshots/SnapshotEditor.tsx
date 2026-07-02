/**
 * Context-snapshots editor — a compact two-tab surface:
 *
 *   ┌ [Snapshots] [Memória] ──────────────────────────────┐
 *   │  Snapshots: master/detail (list + rendered detail)   │
 *   │  Memória:   project/agent memory health + curation   │
 *   └──────────────────────────────────────────────────────┘
 *
 * Snapshots is the default tab so the list sits at the top of the surface
 * instead of being pushed below the memory diagnostics strip. The memory
 * cards only mount (and poll) while the Memória tab is active — no wasted
 * fetches/polling when the user is just browsing snapshots.
 *
 * Edit/Create flows route through the modal `SnapshotForm` — kept off the
 * detail surface so the read-only view stays uncluttered.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Plus } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { useConfirm } from '../../components/ui/dialog-provider.js';
import { cn } from '../../lib/utils.js';
import { apiDelete, apiPut, useApi } from '../../hooks/useApi.js';
import { SnapshotList } from './parts/SnapshotList.js';
import { SnapshotDetail } from './parts/SnapshotDetail.js';
import { SnapshotForm } from './parts/SnapshotForm.js';
import { MemoryHealthCard } from './parts/MemoryHealthCard.js';
import { AgentMemoryHealthCard } from './parts/AgentMemoryHealthCard.js';
import { AgentMemoryList } from './parts/AgentMemoryList.js';
import type { Snapshot } from './snapshot-types.js';

/** Pin = boost retrieval salience; unpin returns to the default mid-weight. */
const PIN_IMPORTANCE = 0.95;
const UNPIN_IMPORTANCE = 0.5;
export const PIN_THRESHOLD = 0.9;

type EditorTab = 'snapshots' | 'memory';

interface SnapshotEditorProps {
  projectId: number;
}

export default function SnapshotEditor({ projectId }: SnapshotEditorProps) {
  const { t } = useTranslation(['projects', 'common']);
  const confirm = useConfirm();
  const [tab, setTab] = useState<EditorTab>('snapshots');
  const [filterCategory, setFilterCategory] = useState<string>('');
  const categoryParam = filterCategory ? `?category=${filterCategory}` : '';
  const { data: snapshots, loading, refetch } = useApi<Snapshot[]>(
    `/projects/${projectId}/snapshots${categoryParam}`,
  );

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  // `null` = creating a new snapshot; `Snapshot` = editing that one.
  const [editTarget, setEditTarget] = useState<Snapshot | null>(null);

  // Keep the selection alive across refetches by matching on id rather
  // than holding the snapshot object directly. When the selected id no
  // longer exists (e.g. after a delete or category filter narrows the
  // list) we drop to `null` so the detail pane shows its empty state.
  const selected = useMemo<Snapshot | null>(() => {
    if (selectedId == null || !snapshots) return null;
    return snapshots.find((s) => s.id === selectedId) ?? null;
  }, [selectedId, snapshots]);

  // Auto-select the first snapshot whenever the visible list changes and
  // the user has nothing selected — saves an extra click on first load
  // and after switching category filters.
  useEffect(() => {
    if (!snapshots || snapshots.length === 0) return;
    if (selectedId != null && snapshots.some((s) => s.id === selectedId)) return;
    setSelectedId(snapshots[0].id);
  }, [snapshots, selectedId]);

  const handleNew = () => {
    setEditTarget(null);
    setFormOpen(true);
  };

  const handleEdit = () => {
    if (!selected) return;
    setEditTarget(selected);
    setFormOpen(true);
  };

  const handleDelete = async () => {
    if (!selected) return;
    const ok = await confirm({
      title: t('projects:snapshots.deleteConfirm'),
      description: t('projects:snapshots.deleteDescription'),
      variant: 'destructive',
      confirmLabel: t('common:actions.delete'),
    });
    if (!ok) return;
    await apiDelete(`/snapshots/${selected.id}`);
    setSelectedId(null);
    refetch();
  };

  // Pin = importance boost so the memory wins retrieval ranking + the
  // turn-1 index. Metadata-only PUT (no version row, no re-embed).
  const handleTogglePin = async () => {
    if (!selected) return;
    const pinned = (selected.importance ?? 0.5) >= PIN_THRESHOLD;
    await apiPut(`/snapshots/${selected.id}`, {
      importance: pinned ? UNPIN_IMPORTANCE : PIN_IMPORTANCE,
    });
    refetch();
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-1 px-2 h-9 border-b bg-card shrink-0">
        <TabButton active={tab === 'snapshots'} onClick={() => setTab('snapshots')}>
          {t('projects:snapshotEditor.tab.snapshots')}
          {snapshots && (
            <span className="ml-1 text-[10px] text-muted-foreground">{snapshots.length}</span>
          )}
        </TabButton>
        <TabButton active={tab === 'memory'} onClick={() => setTab('memory')}>
          {t('projects:snapshotEditor.tab.memory')}
        </TabButton>
      </div>

      {tab === 'memory' ? (
        // Memory diagnostics + curation — only mounts (and polls) while active.
        <div className="flex-1 min-h-0 overflow-y-auto">
          <MemoryHealthCard projectId={projectId} />
          <AgentMemoryHealthCard projectId={projectId} />
          <AgentMemoryList projectId={projectId} />
        </div>
      ) : loading ? (
        <div className="px-4 py-6 text-sm text-muted-foreground">
          {t('common:actions.loading')}
        </div>
      ) : (
        <div className="flex flex-1 min-h-0">
          <PanelGroup
            direction="horizontal"
            autoSaveId="snapshots-editor-cols"
            className="flex-1 min-h-0"
          >
            <Panel
              id="snapshots-list"
              order={1}
              defaultSize={28}
              minSize={20}
              maxSize={45}
              className="min-w-0"
            >
              <SnapshotList
                snapshots={snapshots ?? []}
                selectedId={selectedId}
                filterCategory={filterCategory}
                onFilterCategory={(c) => {
                  setFilterCategory(c);
                  // Don't keep a stale selection from the previous filter —
                  // the auto-select effect picks the new first row.
                  setSelectedId(null);
                }}
                onSelect={setSelectedId}
                onNew={handleNew}
              />
            </Panel>
            <PanelResizeHandle className="w-px bg-border hover:bg-primary/40 transition-colors" />
            <Panel id="snapshots-detail" order={2} minSize={40} className="min-w-0">
              {selected ? (
                <SnapshotDetail
                  snapshot={selected}
                  onEdit={handleEdit}
                  onDelete={handleDelete}
                  onTogglePin={handleTogglePin}
                />
              ) : (
                <EmptyDetail onNew={handleNew} />
              )}
            </Panel>
          </PanelGroup>
        </div>
      )}

      <SnapshotForm
        projectId={projectId}
        snapshot={editTarget}
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) setEditTarget(null);
        }}
        onSaved={refetch}
      />
    </div>
  );
}

/** Compact segmented tab button matching the IDE's dense chrome. */
function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center h-7 px-2.5 rounded-md text-xs font-medium transition-colors',
        active
          ? 'bg-primary/10 text-primary'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

function EmptyDetail({ onNew }: { onNew: () => void }) {
  const { t } = useTranslation(['projects', 'common']);
  return (
    <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3">
      <p className="text-sm">{t('projects:snapshots.none')}</p>
      <Button size="sm" onClick={onNew} className="gap-1.5">
        <Plus className="h-3.5 w-3.5" />
        {t('projects:snapshots.newSnapshot')}
      </Button>
    </div>
  );
}
