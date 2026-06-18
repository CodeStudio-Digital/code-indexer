/**
 * 3-way merge editor (IntelliJ-style): Local (ours) | Result (editable,
 * MARKER-FREE) | Incoming (theirs). Every change is highlighted per side
 * (blue/green/amber); gutter arrows push a side into the Result; the Result
 * lens resolves conflicts; the magic wand applies non-conflicting changes.
 * Built on the pure merge-model + the merge-controller (live region anchors).
 */

import { useEffect, useRef, useState } from 'react';
import * as monaco from 'monaco-editor';
import { useTranslation } from 'react-i18next';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { ArrowDown, ArrowLeftToLine, ArrowRightToLine, ArrowUp, Check, Loader2, Wand2, X } from 'lucide-react';
import type { GitConflictFile, ConflictResolution } from '@mcp/api-bus';
import type { OpenMerge } from '../../../../state/workspace.js';
import { apiCall } from '../../../../lib/api-client.js';
import { Button } from '../../../../components/ui/button.js';
import { confirm, toast } from '../../../../components/ui/prompt-dialog.js';
import { useWorkspaceStore } from '../../../../state/workspace.js';
import { requestGitReload } from '../conflict-registry.js';
import { computeMergeRegions } from './model/merge-regions.js';
import { buildInitialResult, detectEol } from './model/build-result.js';
import { mountThreePane, type ThreePaneHandles } from './three-pane-models.js';
import { createMergeController, type MergeController } from './merge-controller.js';

const detectDark = () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

export function MergeTabView({ tab }: { tab: OpenMerge }) {
  const { t } = useTranslation('workspace');
  const tRef = useRef(t);
  tRef.current = t;
  const closeFile = useWorkspaceStore((s) => s.closeFile);
  const [data, setData] = useState<GitConflictFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [counts, setCounts] = useState({ changes: 0, conflicts: 0, unresolved: 0 });
  const oursRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const theirsRef = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<MergeController | null>(null);

  // The panes bake the theme at mount (imperative monaco.editor.create); re-apply
  // on a runtime light/dark toggle. setTheme is global → one call themes all panes.
  useEffect(() => {
    const obs = new MutationObserver(() => monaco.editor.setTheme(detectDark() ? 'vs-dark' : 'vs'));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    let alive = true;
    apiCall<GitConflictFile>('projectGit.conflictFile', { projectId: tab.projectId, path: tab.file })
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [tab.projectId, tab.file]);

  // Mount the 3 panes + controller once data + DOM are ready (text files only).
  useEffect(() => {
    if (!data || data.binary) return;
    const els = { ours: oursRef.current, result: resultRef.current, theirs: theirsRef.current };
    if (!els.ours || !els.result || !els.theirs) return;
    const model = computeMergeRegions(data.base, data.ours, data.theirs);
    const eol = detectEol(data.ours ?? data.theirs ?? data.base ?? '');
    const seed = buildInitialResult(model, eol).text;
    const handles: ThreePaneHandles = mountThreePane(
      { ours: els.ours, result: els.result, theirs: els.theirs },
      { file: tab.file, ours: data.ours ?? '', theirs: data.theirs ?? '', result: seed, dark: detectDark() },
    );
    const tt = tRef.current;
    const ctrl = createMergeController(handles, model, eol, {
      ours: tt('git.conflict.acceptCurrent'),
      theirs: tt('git.conflict.acceptIncoming'),
      both: tt('git.conflict.acceptBoth'),
      reject: tt('git.merge.reject'),
    });
    ctrlRef.current = ctrl;
    const sync = () => setCounts({ changes: ctrl.changeCount, conflicts: ctrl.conflictCount, unresolved: ctrl.unresolvedConflicts() });
    sync();
    const off = ctrl.onChange(sync);
    return () => { off(); ctrl.dispose(); handles.dispose(); ctrlRef.current = null; };
  }, [data, tab.file]);

  const resolveWith = async (resolution: ConflictResolution) => {
    setApplying(true);
    try {
      await apiCall('projectGit.resolveConflict', { projectId: tab.projectId, path: tab.file, resolution });
      requestGitReload();
      closeFile(tab.projectId, tab.path);
    } catch (e) {
      toast.error(t('git.conflict.resolveFailed'), { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setApplying(false);
    }
  };

  const apply = async () => {
    const ctrl = ctrlRef.current;
    if (!ctrl) return;
    if (ctrl.unresolvedConflicts() > 0) {
      const ok = await confirm({
        title: t('git.merge.unresolvedTitle'),
        description: t('git.merge.unresolvedBody', { count: ctrl.unresolvedConflicts() }),
        confirmLabel: t('git.conflict.applyMerge'),
      });
      if (!ok) return;
    }
    await resolveWith({ content: ctrl.getResult() });
  };

  const ctrl = () => ctrlRef.current;
  return (
    <div className="h-full flex flex-col min-h-0 bg-background">
      <div className="shrink-0 px-3 py-1.5 border-b flex items-center gap-2 text-[11px]">
        <span className="font-mono truncate" title={tab.file}>{tab.file}</span>
        {data && !data.binary && (
          <>
            <span className="text-muted-foreground/70 shrink-0">
              {t('git.merge.changeCount', { changes: counts.changes, conflicts: counts.conflicts })}
            </span>
            <div className="ml-auto flex items-center gap-1">
              <ToolbarBtn icon={Wand2} label={t('git.merge.applyNonConflicting')} onClick={() => ctrl()?.applyNonConflicting()} />
              <span className="w-px h-4 bg-border mx-1" />
              <ToolbarBtn icon={ArrowUp} label={t('git.merge.prevChange')} onClick={() => ctrl()?.navigate(-1)} />
              <ToolbarBtn icon={ArrowDown} label={t('git.merge.nextChange')} onClick={() => ctrl()?.navigate(1)} />
              <span className="w-px h-4 bg-border mx-1" />
              <ToolbarBtn icon={ArrowLeftToLine} label={t('git.conflict.acceptAllLeft')} onClick={() => ctrl()?.acceptAll('ours')} />
              <ToolbarBtn icon={ArrowRightToLine} label={t('git.conflict.acceptAllRight')} onClick={() => ctrl()?.acceptAll('theirs')} />
              <span className="w-px h-4 bg-border mx-1" />
              <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px] gap-1 text-emerald-500" disabled={applying} onClick={() => void apply()}>
                {applying ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                {t('git.conflict.applyMerge')}
              </Button>
              <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px] gap-1 text-muted-foreground" onClick={() => closeFile(tab.projectId, tab.path)}>
                <X className="h-3 w-3" />
                {t('git.conflict.cancel')}
              </Button>
            </div>
          </>
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

      <div className={data && !data.binary ? 'flex-1 min-h-0' : 'hidden'}>
        <PanelGroup direction="horizontal" autoSaveId="mcp-merge-3pane" className="h-full">
          <MergePane title={t('git.conflict.paneLocal')} paneRef={oursRef} />
          <PanelResizeHandle className="w-px bg-border hover:bg-primary/40 transition-colors" />
          <MergePane title={t('git.conflict.paneResult')} paneRef={resultRef} accent />
          <PanelResizeHandle className="w-px bg-border hover:bg-primary/40 transition-colors" />
          <MergePane title={t('git.conflict.paneIncoming')} paneRef={theirsRef} />
        </PanelGroup>
      </div>
    </div>
  );
}

function MergePane({ title, paneRef, accent }: { title: string; paneRef: React.RefObject<HTMLDivElement>; accent?: boolean }) {
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

function ToolbarBtn({ icon: Icon, label, onClick }: { icon: React.ComponentType<{ className?: string }>; label: string; onClick: () => void }) {
  return (
    <button type="button" title={label} onClick={onClick} className="h-6 w-6 grid place-items-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}
