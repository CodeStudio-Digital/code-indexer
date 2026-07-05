/**
 * LEFT-rail Frames browser: the character's whole version universe, grouped by
 * generation batch ("job#40 · idle · 6f"), collapsible, virtualized, with
 * multi-select → bulk delete / add-to-timeline and drag-to-timeline. Data
 * (versions/generations/refresh) is the single lifted useAssetVersions fetch;
 * selection + the timeline bridge live in the session store.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import { loadSpriteStudioUi, saveSpriteStudioUi } from '../../sprite-studio-ui-state.js';
import type { AssetVersion } from '../../types.js';
import { useAnimateSession } from '../animate-session-store.js';
import type { GenerationGroup } from '../api-anim-bulk.js';
import { buildFrameGroups, defaultGridFor, type FrameGroupView } from '../version-groups.js';
import { FramesBrowserToolbar } from './FramesBrowserToolbar.js';
import { VersionGroupHeader } from './VersionGroupHeader.js';
import { VersionMiniGrid } from './VersionMiniGrid.js';
import { SelectionActionBar } from './SelectionActionBar.js';
import { ResliceSheetDialog } from './ResliceSheetDialog.js';
import { useSelectionActions } from './useSelectionActions.js';
import { buildFrameRows, orderedVersionIds } from './useVersionRows.js';

const THUMB_MIN_W = 60;
const GAP = 6;
const HEADER_H = 28;

export function FramesBrowserPanel({
  projectId,
  assetId,
  currentVersionId,
  versions,
  generations,
  refresh,
  onSelectVersion,
  onImport,
}: {
  projectId: number;
  assetId: number;
  currentVersionId: number | null;
  versions: AssetVersion[];
  generations: GenerationGroup[];
  refresh: () => void;
  onSelectVersion: (versionId: number) => void;
  onImport: () => void;
}) {
  const { t } = useTranslation('spriteStudio');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const { busy, deleteVersions, addToTimeline, restoreTimeline } = useSelectionActions(projectId, refresh);
  const [width, setWidth] = useState(220);
  const [query, setQuery] = useState('');
  const [reslice, setReslice] = useState<FrameGroupView | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(loadSpriteStudioUi(projectId)?.collapsedFrameGroups ?? []),
  );
  const [groupLabels, setGroupLabels] = useState<Record<string, string>>(
    () => loadSpriteStudioUi(projectId)?.groupLabels ?? {},
  );
  const seededRef = useRef(false);

  const versionById = useMemo(() => new Map(versions.map((v) => [v.id, v] as const)), [versions]);
  const groups = useMemo(() => buildFrameGroups(generations, versionById), [generations, versionById]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter((g) =>
      [g.animationName, g.prompt, g.kind, g.jobId != null ? `job#${g.jobId}` : 'manual']
        .some((s) => s?.toLowerCase().includes(q)),
    );
  }, [groups, query]);

  const cols = Math.max(1, Math.floor((width - GAP) / (THUMB_MIN_W + GAP)));
  const rows = useMemo(() => buildFrameRows(filtered, collapsed, cols), [filtered, collapsed, cols]);
  const orderedIds = useMemo(() => orderedVersionIds(filtered), [filtered]);
  const cellW = Math.floor((width - 16 - (cols - 1) * GAP) / cols);
  const thumbRowH = Math.max(28, cellW + 8);

  // Column count follows the panel width.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const compute = () => setWidth(el.clientWidth);
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Default view: collapse every batch but the newest — never re-flood.
  useEffect(() => {
    if (seededRef.current || groups.length <= 1) return;
    seededRef.current = true;
    if (collapsed.size > 0) return;
    const seed = new Set(groups.slice(1).map((g) => g.key));
    setCollapsed(seed);
    saveSpriteStudioUi(projectId, { collapsedFrameGroups: [...seed] });
  }, [groups, collapsed, projectId]);

  const persistCollapsed = useCallback((next: Set<string>) => {
    setCollapsed(next);
    saveSpriteStudioUi(projectId, { collapsedFrameGroups: [...next] });
  }, [projectId]);

  const toggleCollapse = useCallback((key: string) => {
    persistCollapsed(new Set(collapsed.has(key) ? [...collapsed].filter((k) => k !== key) : [...collapsed, key]));
  }, [collapsed, persistCollapsed]);

  const renameGroup = useCallback((g: FrameGroupView, name: string) => {
    setGroupLabels((prev) => {
      const next = { ...prev };
      if (name) next[g.key] = name;
      else delete next[g.key];
      saveSpriteStudioUi(projectId, { groupLabels: next });
      return next;
    });
  }, [projectId]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.kind === 'header' ? HEADER_H : thumbRowH),
    overscan: 6,
  });

  const onThumbClick = useCallback((id: number, e: React.MouseEvent) => {
    const s = useAnimateSession.getState();
    if (s.selectMode || e.shiftKey || e.metaKey || e.ctrlKey) {
      if (e.shiftKey) s.selectRange(id, orderedIds);
      else s.toggleOne(id);
    } else {
      onSelectVersion(id);
    }
  }, [orderedIds, onSelectVersion]);

  const deleteGroup = useCallback((g: FrameGroupView) => {
    void deleteVersions(g.versions.map((v) => v.id));
  }, [deleteVersions]);

  const deleteSelected = useCallback(() => {
    void deleteVersions([...useAnimateSession.getState().selected]);
  }, [deleteVersions]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <FramesBrowserToolbar
        query={query}
        onQuery={setQuery}
        onExpandAll={() => persistCollapsed(new Set())}
        onCollapseAll={() => persistCollapsed(new Set(groups.map((g) => g.key)))}
        onImport={onImport}
      />
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {assetId <= 0 ? (
          <div className="p-4 text-center text-[11px] text-muted-foreground">{t('frames.emptyPickAsset')}</div>
        ) : rows.length === 0 ? (
          <div className="p-4 text-center text-[11px] text-muted-foreground">{t('frames.emptyNoVersions')}</div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const row = rows[vi.index];
              return (
                <div
                  key={vi.key}
                  className="absolute left-0 w-full"
                  style={{ top: 0, transform: `translateY(${vi.start}px)`, height: vi.size }}
                >
                  {row.kind === 'header' ? (
                    <VersionGroupHeader
                      group={row.group}
                      collapsed={collapsed.has(row.group.key)}
                      customLabel={groupLabels[row.group.key]}
                      onToggleCollapse={toggleCollapse}
                      onGroupSelect={(ids, on) => useAnimateSession.getState().setGroup(ids, on)}
                      onGroupDelete={deleteGroup}
                      onRestoreGroup={(g) => restoreTimeline(g.versions.map((v) => v.id))}
                      onReslice={setReslice}
                      onRename={renameGroup}
                    />
                  ) : (
                    <VersionMiniGrid
                      projectId={projectId}
                      versions={row.versions}
                      cols={cols}
                      currentVersionId={currentVersionId}
                      onThumbClick={onThumbClick}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <SelectionActionBar onAddToTimeline={() => addToTimeline(orderedIds)} onDelete={deleteSelected} busy={busy} />
      {reslice?.jobId != null && (
        <ResliceSheetDialog
          open
          onOpenChange={(v) => { if (!v) setReslice(null); }}
          projectId={projectId}
          assetId={assetId}
          jobId={reslice.jobId}
          defaultGrid={defaultGridFor(reslice)}
          refresh={refresh}
        />
      )}
    </div>
  );
}
