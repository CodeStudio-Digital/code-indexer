/**
 * 3-pane merge editor (WebStorm-style): Local (ours) | Result (editable) |
 * Incoming (theirs). The Result pane is seeded with git's working-tree
 * text (markers included); per-conflict Accept Current/Incoming/Both lives
 * on its CodeLens, and the toolbar adds navigation, Accept-all, and Apply.
 *
 * v1 has no scroll-sync between panes (a known re-entrancy footgun); the
 * Result pane is the source of truth and the side panes are reference.
 */

import { useEffect, useRef, useState } from 'react';
import * as monaco from 'monaco-editor';
import { useTranslation } from 'react-i18next';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { ArrowDown, ArrowLeftToLine, ArrowRightToLine, ArrowUp, Check, Loader2, X } from 'lucide-react';
import type { GitConflictFile, ConflictResolution } from '@mcp/api-bus';
import type { OpenMerge } from '../../../../state/workspace.js';
import { apiCall } from '../../../../lib/api-client.js';
import { Button } from '../../../../components/ui/button.js';
import { confirm, toast } from '../../../../components/ui/prompt-dialog.js';
import { useWorkspaceStore } from '../../../../state/workspace.js';
import { requestGitReload } from '../conflict-registry.js';
import {
  applyResolution,
  attachConflictUI,
  parseConflictRegions,
  type ConflictSide,
} from '../conflict-markers.js';
import { mountThreePane, type ThreePaneHandles } from './three-pane-models.js';

const detectDark = () =>
  typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

export function MergeTabView({ tab }: { tab: OpenMerge }) {
  const { t } = useTranslation('workspace');
  const closeFile = useWorkspaceStore((s) => s.closeFile);
  const [data, setData] = useState<GitConflictFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const oursRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const theirsRef = useRef<HTMLDivElement>(null);
  const handlesRef = useRef<ThreePaneHandles | null>(null);

  useEffect(() => {
    let alive = true;
    apiCall<GitConflictFile>('projectGit.conflictFile', { projectId: tab.projectId, path: tab.file })
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [tab.projectId, tab.file]);

  // Mount the three editors once data + DOM are ready (text files only).
  useEffect(() => {
    if (!data || data.binary) return;
    const els = { ours: oursRef.current, result: resultRef.current, theirs: theirsRef.current };
    if (!els.ours || !els.result || !els.theirs) return;
    const handles = mountThreePane(
      { ours: els.ours, result: els.result, theirs: els.theirs },
      { file: tab.file, ours: data.ours ?? '', theirs: data.theirs ?? '', merged: data.merged, dark: detectDark() },
    );
    handlesRef.current = handles;
    const ui = attachConflictUI(handles.resultEditor, monaco, {
      current: t('git.conflict.acceptCurrent'),
      incoming: t('git.conflict.acceptIncoming'),
      both: t('git.conflict.acceptBoth'),
    });
    return () => { ui.dispose(); handles.dispose(); handlesRef.current = null; };
  }, [data, tab.file, t]);

  const navigate = (dir: 1 | -1) => {
    const ed = handlesRef.current?.resultEditor;
    const model = ed?.getModel();
    if (!ed || !model) return;
    const regions = parseConflictRegions(model.getValue());
    if (!regions.length) return;
    const line = ed.getPosition()?.lineNumber ?? 0;
    const target = dir === 1
      ? regions.find((r) => r.startLine > line) ?? regions[0]
      : [...regions].reverse().find((r) => r.startLine < line) ?? regions[regions.length - 1];
    ed.revealLineInCenter(target.startLine);
    ed.setPosition({ lineNumber: target.startLine, column: 1 });
    ed.focus();
  };

  const acceptAll = (side: ConflictSide) => {
    const ed = handlesRef.current?.resultEditor;
    const model = ed?.getModel();
    if (!ed || !model) return;
    for (let i = 0; i < 5000; i++) {
      const regions = parseConflictRegions(model.getValue());
      if (!regions.length) break;
      applyResolution(ed, regions[0].startLine, side);
    }
  };

  const resolveWith = async (resolution: ConflictResolution) => {
    setApplying(true);
    try {
      await apiCall('projectGit.resolveConflict', { projectId: tab.projectId, path: tab.file, resolution });
      requestGitReload();
      closeFile(tab.path);
    } catch (e) {
      toast.error(t('git.conflict.resolveFailed'), { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setApplying(false);
    }
  };

  const apply = async () => {
    const content = handlesRef.current?.getResult();
    if (content == null) return;
    if (parseConflictRegions(content).length > 0) {
      const ok = await confirm({
        title: t('git.conflict.markersRemainTitle'),
        description: t('git.conflict.markersRemainBody'),
        confirmLabel: t('git.conflict.applyMerge'),
      });
      if (!ok) return;
    }
    await resolveWith({ content });
  };

  return (
    <div className="h-full flex flex-col min-h-0 bg-background">
      <div className="shrink-0 px-3 py-1.5 border-b flex items-center gap-2 text-[11px]">
        <span className="font-mono truncate" title={tab.file}>{tab.file}</span>
        {data && !data.binary && (
          <div className="ml-auto flex items-center gap-1">
            <ToolbarBtn icon={ArrowUp} label={t('git.conflict.prevConflict')} onClick={() => navigate(-1)} />
            <ToolbarBtn icon={ArrowDown} label={t('git.conflict.nextConflict')} onClick={() => navigate(1)} />
            <span className="w-px h-4 bg-border mx-1" />
            <ToolbarBtn icon={ArrowLeftToLine} label={t('git.conflict.acceptAllLeft')} onClick={() => acceptAll('current')} />
            <ToolbarBtn icon={ArrowRightToLine} label={t('git.conflict.acceptAllRight')} onClick={() => acceptAll('incoming')} />
            <span className="w-px h-4 bg-border mx-1" />
            <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px] gap-1 text-emerald-500" disabled={applying} onClick={() => void apply()}>
              {applying ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
              {t('git.conflict.applyMerge')}
            </Button>
            <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px] gap-1 text-muted-foreground" onClick={() => closeFile(tab.path)}>
              <X className="h-3 w-3" />
              {t('git.conflict.cancel')}
            </Button>
          </div>
        )}
      </div>

      {error && <div className="px-3 py-2 text-[11px] text-destructive">{error}</div>}
      {!data && !error && (
        <div className="flex-1 grid place-items-center"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
      )}

      {data && data.binary && (
        <div className="flex-1 grid place-items-center px-6 text-center gap-3">
          <p className="text-[12px] text-muted-foreground">{t('git.conflict.binaryNote')}</p>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={applying} onClick={() => void resolveWith('ours')}>{t('git.conflict.acceptYours')}</Button>
            <Button size="sm" variant="outline" disabled={applying} onClick={() => void resolveWith('theirs')}>{t('git.conflict.acceptTheirs')}</Button>
          </div>
        </div>
      )}

      {data && !data.binary && (
        <PanelGroup direction="horizontal" autoSaveId="mcp-merge-3pane" className="flex-1 min-h-0">
          <MergePane title={t('git.conflict.paneLocal')} paneRef={oursRef} />
          <PanelResizeHandle className="w-px bg-border hover:bg-primary/40 transition-colors" />
          <MergePane title={t('git.conflict.paneResult')} paneRef={resultRef} accent />
          <PanelResizeHandle className="w-px bg-border hover:bg-primary/40 transition-colors" />
          <MergePane title={t('git.conflict.paneIncoming')} paneRef={theirsRef} />
        </PanelGroup>
      )}
    </div>
  );
}

function MergePane({
  title, paneRef, accent,
}: { title: string; paneRef: React.RefObject<HTMLDivElement>; accent?: boolean }) {
  return (
    <Panel defaultSize={33} minSize={15}>
      <div className="h-full flex flex-col min-h-0">
        <div className={`shrink-0 px-2 py-1 text-[10.5px] font-medium border-b ${accent ? 'text-primary' : 'text-muted-foreground'}`}>
          {title}
        </div>
        <div ref={paneRef} className="flex-1 min-h-0" />
      </div>
    </Panel>
  );
}

function ToolbarBtn({
  icon: Icon, label, onClick,
}: { icon: React.ComponentType<{ className?: string }>; label: string; onClick: () => void }) {
  return (
    <button type="button" title={label} onClick={onClick} className="h-6 w-6 grid place-items-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}
