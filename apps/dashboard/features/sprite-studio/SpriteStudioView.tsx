/**
 * Sprite Studio — top-level route view (`/sprites`) hosted by the shared
 * workbench chrome. It carries its own project selector, a CTA to initialize
 * `.sprite-studio/` on first use, then the studio tool windows.
 * Deep-link: `/sprites?project=<id>`; the last project is remembered.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronDown, FolderOpen, ImagePlay, Loader2 } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { StatusBarShell } from '../../components/chrome/index.js';
import { WorkbenchShell } from '../../components/workbench/index.js';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu.js';
import { useApi } from '../../hooks/useApi.js';
import * as api from './api.js';
import { useSpriteStudio } from './useSpriteStudio.js';
import {
  disposeAllEngines, disposeEngine, disposeEnginesByPrefix, engineKey, getEngine, peekEngine,
} from './engine/engine-registry.js';
import { editorTabKey, useEditorTabs, type EditorTab } from './edit/editor-tabs.js';
import { confirm } from '../../components/ui/prompt-dialog.js';
import { loadLastSpriteProject, saveLastSpriteProject } from './sprite-studio-ui-state.js';
import { StudioToolbar } from './StudioToolbar.js';
import { LibraryPanel } from './library/LibraryPanel.js';
import { InspectorPanel } from './inspector/InspectorPanel.js';
import { CenterSurface } from './CenterSurface.js';
import { StudioPanels } from './panels/StudioPanels.js';
import { ExportDialog } from './export/ExportDialog.js';
import { ModelSelector } from './ModelSelector.js';
import { useAssetVersions } from './animate/useAssetVersions.js';
import { saveFrameVersion } from './animate/api-anim.js';
import { useAnimateSession } from './animate/animate-session-store.js';
import { FramesBrowserPanel } from './animate/frames/FramesBrowserPanel.js';
import { ImportSheetDialog } from './animate/frames/ImportSheetDialog.js';
import type { EditorEngine } from './engine/EditorEngine.js';

export function SpriteStudioView() {
  const { t } = useTranslation('spriteStudio');
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: projects } = useApi<Array<{ id: number; name: string }>>('/projects');

  // `?project=` wins; otherwise fall back to the last project used here.
  const paramRaw = searchParams.get('project');
  const paramId = paramRaw != null ? Number(paramRaw) : NaN;
  const [fallbackId] = useState<number | null>(() => loadLastSpriteProject());
  const projectId = Number.isFinite(paramId) && paramId > 0 ? paramId : fallbackId;

  const c = useSpriteStudio(projectId);
  const { state } = c;

  // Persist + reflect the effective project in the URL (shareable deep-link).
  useEffect(() => {
    if (projectId == null) return;
    saveLastSpriteProject(projectId);
    if (searchParams.get('project') !== String(projectId)) {
      setSearchParams({ project: String(projectId) }, { replace: true });
    }
  }, [projectId, searchParams, setSearchParams]);

  const selectProject = (id: number) => setSearchParams({ project: String(id) }, { replace: true });
  const projectName = projects?.find((p) => p.id === projectId)?.name ?? null;

  // The live editor engine (edit mode) — surfaced by EditModeView so the
  // inspector's Adjust/Palette cards operate on the same instance.
  const [engine, setEngine] = useState<EditorEngine | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  // Focused edit session: "Editar frame"/pencil opens the editor locked onto
  // ONE version — primary save OVERWRITES it in place ("Salvar Sprite").
  const [editSession, setEditSession] = useState<{
    versionId: number; origin: 'frame' | 'version';
    animationId?: number; frameIndex?: number; track?: number;
  } | null>(null);

  // Single lifted version+generation fetch shared by all three animate rails
  // (center provenance, LEFT Frames browser, RIGHT FrameInspector).
  const av = useAssetVersions(projectId ?? 0, state.activeAssetId ?? 0);
  const activeAnimation = useAnimateSession((s) => s.animContext);
  const timelineCanUndo = useAnimateSession((s) => s.timelineCanUndo);
  const timelineCanRedo = useAnimateSession((s) => s.timelineCanRedo);
  const timelineUndo = useAnimateSession((s) => s.timelineUndo);
  const timelineRedo = useAnimateSession((s) => s.timelineRedo);
  const selectedAnimationFrame = useAnimateSession((s) => s.selectedFrameIndex);

  // Reset the cross-rail selection/bridge whenever the focused asset changes.
  useEffect(() => {
    useAnimateSession.getState().resetForAsset();
    setEditSession(null);
  }, [projectId, state.activeAssetId]);

  // Switching project: close every tab and dispose all engines (they're keyed
  // by the old project). Guarded by a previous-id ref: the effect must NOT run
  // on a plain route remount (engines/tabs exist precisely to survive leaving
  // /sprites and coming back — wiping here destroyed unsaved edits silently).
  const prevProjectRef = useRef(projectId);
  useEffect(() => {
    if (prevProjectRef.current === projectId) return;
    prevProjectRef.current = projectId;
    useEditorTabs.getState().reset();
    disposeAllEngines();
  }, [projectId]);

  // Monotonic guard for async tab focusing: a newer focus/close supersedes an
  // older one, so a slow selectAsset can't land its selectVersion on top of a
  // different asset (mixing (assetId, versionId) across two tabs).
  const focusSeqRef = useRef(0);
  const focusImage = (assetId: number, versionId: number | null) => {
    const seq = ++focusSeqRef.current;
    void (async () => {
      if (assetId !== state.activeAssetId) await c.selectAsset(assetId);
      if (focusSeqRef.current !== seq) return; // superseded
      c.selectVersion(versionId);
    })();
  };

  // Multi-tab editor: focus a tab = select its asset AND its exact version
  // (tabs are per IMAGE — two frames of the same asset are two tabs).
  const onFocusTab = (tab: EditorTab) => focusImage(tab.assetId, tab.versionId);
  const onCloseTab = async (tab: EditorTab) => {
    if (projectId != null) {
      const key = engineKey(projectId, tab.assetId, tab.versionId);
      // isDirty (not canUndo): a saved doc keeps its undo stack but closing
      // it must NOT nag about discarding.
      if (getEngine(key)?.isDirty) {
        const ok = await confirm({
          title: t('editor.closeTabConfirmTitle'),
          description: t('editor.closeTabConfirmBody'),
          confirmLabel: t('editor.closeTabConfirm'),
          tone: 'destructive',
        });
        if (!ok) return;
      }
      disposeEngine(key);
    }
    ++focusSeqRef.current;
    const beforeTabs = useEditorTabs.getState().tabs;
    const idx = beforeTabs.findIndex((tb) => tb.key === tab.key);
    useEditorTabs.getState().closeTab(tab.key);
    const wasActive = tab.assetId === state.activeAssetId
      && (tab.versionId ?? null) === (state.activeVersionId ?? null);
    if (wasActive) {
      const tabs = useEditorTabs.getState().tabs;
      const neighbor = tabs[Math.min(Math.max(0, idx), tabs.length - 1)];
      if (!neighbor) { void c.selectAsset(null); return; }
      focusImage(neighbor.assetId, neighbor.versionId);
    }
  };

  // Leaving edit mode abandons the focused session (generic editor returns).
  useEffect(() => {
    if (state.mode !== 'edit') setEditSession(null);
  }, [state.mode]);
  // "Iterate from this version" (inspector) → generate mode with the ref queued.
  const [pendingIterate, setPendingIterate] = useState<{ kind: 'version'; versionId: number; label: string } | null>(null);
  const onIterateVersion = (versionId: number, label: string) => {
    setPendingIterate({ kind: 'version', versionId, label });
    c.setMode('generate');
  };
  // Resolve from the controller's list first, then fall back to the shared
  // useAssetVersions map — animation FRAMES live in `av` (a separate fetch) and
  // aren't always in `state.versions`, so "Edit" on a frame would otherwise
  // resolve to null and open a BLANK editor.
  const activeVersion = useMemo(
    () =>
      state.versions.find((v) => v.id === state.activeVersionId)
      ?? (state.activeVersionId != null ? av.versionById.get(state.activeVersionId) ?? null : null),
    [state.versions, state.activeVersionId, av.versionById],
  );

  // Multi-tab editor: keep a tab open for the IMAGE being edited — the exact
  // version, or a new asset's blank doc. When a version tab opens, a CLEAN
  // blank tab of the same asset retires (save-as-new: the blank doc just
  // became this version); a dirty one stays (unsaved strokes must survive).
  useEffect(() => {
    if (state.mode !== 'edit' || !c.activeAsset) return;
    // While a cross-asset selection is still loading its versions, activeVersion
    // is TRANSIENTLY null — don't flash a spurious blank tab for an asset that
    // has a current version; wait for it to resolve.
    if (!activeVersion && c.activeAsset.currentVersionId != null) return;
    const tabsStore = useEditorTabs.getState();
    if (activeVersion) {
      const blankKey = editorTabKey(c.activeAsset.id, null);
      if (tabsStore.tabs.some((tb) => tb.key === blankKey) && projectId != null) {
        const blank = peekEngine(engineKey(projectId, c.activeAsset.id, null));
        if (!blank?.isDirty) {
          tabsStore.closeTab(blankKey);
          disposeEngine(engineKey(projectId, c.activeAsset.id, null));
        }
      }
    }
    tabsStore.openTab({
      key: editorTabKey(c.activeAsset.id, activeVersion?.id ?? null),
      assetId: c.activeAsset.id,
      versionId: activeVersion?.id ?? null,
      label: activeVersion
        ? `${c.activeAsset.name} · v${String(activeVersion.version).padStart(3, '0')}`
        : c.activeAsset.name,
    });
  }, [state.mode, state.activeAssetId, activeVersion?.id, activeVersion?.version, c.activeAsset?.name, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // After a generation is saved or an edit committed, refresh + focus. AWAIT
  // refreshAssets before selectAsset: selectAsset resolves the active version
  // from the client-side asset row, so racing them focused the OLD current
  // version after a save-as-new. In edit mode land exactly on the new version.
  const onSaved = (assetId: number, versionId?: number) => {
    // Save-as-new from the editor: the doc's content now LIVES in the new
    // version — retire the old image's tab/engine when it reads clean
    // (Photoshop "Save As": the tab morphs into the new file). A dirty one
    // (strokes painted mid-save) stays to protect the extra edits.
    if (
      state.mode === 'edit' && projectId != null && versionId != null
      && c.activeAsset?.id === assetId && activeVersion && activeVersion.id !== versionId
    ) {
      const oldKey = engineKey(projectId, assetId, activeVersion.id);
      if (!peekEngine(oldKey)?.isDirty) {
        useEditorTabs.getState().closeTab(editorTabKey(assetId, activeVersion.id));
        disposeEngine(oldKey);
      }
    }
    const seq = ++focusSeqRef.current;
    const inEdit = state.mode === 'edit';
    void (async () => {
      await c.refreshAssets();
      await c.selectAsset(assetId);
      if (focusSeqRef.current !== seq) return;
      if (inEdit && versionId != null && versionId > 0) c.selectVersion(versionId);
    })();
  };

  // Timeline "edit frame": open that exact version in a FOCUSED session —
  // the primary save overwrites it in place, so the frame updates visually.
  const onEditVersion = (_assetId: number, versionId: number, frameIndex: number, track: number) => {
    c.selectVersion(versionId);
    setEditSession({
      versionId, origin: 'frame', animationId: activeAnimation?.animationId, frameIndex, track,
    });
    c.setMode('edit');
  };

  // Versions-list pencil: same focused session, but returning stays in edit.
  const onEditVersionInPlace = (versionId: number) => {
    c.selectVersion(versionId);
    setEditSession({ versionId, origin: 'version' });
    c.setMode('edit');
  };

  // Overwrite: PUT the canvas over the SAME version file, refresh every consumer
  // (thumbs bust via contentHash). Target = the focused-session version, or the
  // version currently loaded in the editor (so overwrite works outside a session
  // too). Only a focused *frame* session hops back to the timeline afterwards.
  const onSaveOverwrite = async (blob: Blob) => {
    const session = editSession;
    const targetId = session?.versionId ?? activeVersion?.id ?? null;
    const assetId = state.activeAssetId;
    if (projectId == null || targetId == null || assetId == null) return;
    if (session?.origin === 'frame' && session.animationId != null && session.frameIndex != null) {
      await saveFrameVersion(
        session.animationId, session.track ?? 0, session.frameIndex, session.versionId, blob,
      );
      setEditSession(null);
      av.refresh();
      await c.refreshAssets();
      await c.selectAsset(assetId);
      c.setMode('animate');
      return;
    }
    const seq = ++focusSeqRef.current;
    await api.overwriteVersion(projectId, targetId, blob);
    setEditSession((current) => (current === session ? null : current));
    av.refresh();
    await c.refreshAssets();
    await c.selectAsset(assetId);
    if (focusSeqRef.current !== seq) return;
    if (session?.origin === 'frame') c.setMode('animate');
    // Stay on the OVERWRITTEN image: selectAsset re-focused the asset's
    // current version, which yanked the canvas to a different image when a
    // non-current version was overwritten in the generic editor.
    else c.selectVersion(targetId);
  };

  const onDeleteAsset = async (assetId: number) => {
    if (projectId == null) return;
    await api.deleteAsset(projectId, assetId);
    disposeEnginesByPrefix(`${projectId}:${assetId}:`);
    useEditorTabs.getState().closeAssetTabs(assetId);
    await c.refreshAssets();
    void c.selectAsset(null);
  };

  const onDeleteVersion = async (versionId: number) => {
    if (projectId == null || state.activeAssetId == null) return;
    const assetId = state.activeAssetId;
    const seq = ++focusSeqRef.current;
    await api.deleteVersion(projectId, versionId);
    // A deleted image can't stay open as a tab/engine.
    useEditorTabs.getState().closeTab(editorTabKey(assetId, versionId));
    disposeEngine(engineKey(projectId, assetId, versionId));
    await c.refreshAssets();
    if (focusSeqRef.current === seq) void c.selectAsset(assetId); // reload the version list
    av.refresh(); // keep the shared Frames-browser view in sync
  };

  // AI-enhance "Aplicar": the backend already promoted the candidate into a new
  // version, but the apply used to create the row and never refresh the UI (the
  // onApplied callback was unwired) — so it "didn't save to the versions list".
  // Reload the shared views + the version list and focus the new version.
  const onEnhanceApplied = async (versionId: number) => {
    if (projectId == null) return;
    av.refresh();
    await c.refreshAssets();
    if (state.activeAssetId != null) await c.selectAsset(state.activeAssetId);
    c.selectVersion(versionId);
  };

  return (
    <WorkbenchShell className="bg-[var(--workbench-canvas)]">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--workbench-border)] bg-[var(--workbench-raised)] px-2 text-xs">
        <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="text-[11px] text-muted-foreground">{t('header.projectLabel')}</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" className="h-6 max-w-[260px] gap-1 bg-[var(--workbench-surface)] px-2 hover:bg-[var(--workbench-hover)]">
              <span className="truncate">{projectName ?? t('header.selectProject')}</span>
              <ChevronDown className="h-3 w-3 shrink-0" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 w-64 overflow-y-auto">
            {(!projects || projects.length === 0) && (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">{t('header.noProjects')}</div>
            )}
            {projects?.map((p) => (
              <DropdownMenuItem key={p.id} onClick={() => selectProject(p.id)}>
                <span className="truncate">{p.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden text-[11px] text-muted-foreground sm:inline">{t('model.label')}</span>
          <ModelSelector />
        </div>
      </div>

      {projectId == null ? (
        <CenterCard icon={FolderOpen} title={t('header.selectProject')} body={t('header.selectProjectHint')} />
      ) : state.loading ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground" aria-busy="true">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : state.error ? (
        <div className="m-1.5 rounded border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-400">
          {state.error}
        </div>
      ) : !state.initialized ? (
        <CenterCard icon={ImagePlay} title={t('init.title')} body={t('init.description')}>
          <Button size="sm" onClick={() => void c.initStudio()}>{t('init.action')}</Button>
        </CenterCard>
      ) : (
        <>
          <StudioToolbar
            mode={state.mode}
            onMode={c.setMode}
            assetName={c.activeAsset?.name ?? null}
            contextLabel={state.mode === 'animate' && activeAnimation
              ? `${activeAnimation.name}${selectedAnimationFrame != null ? ` › Frame ${selectedAnimationFrame + 1}` : ''}`
              : null}
            canUndo={state.mode === 'animate' && timelineCanUndo}
            canRedo={state.mode === 'animate' && timelineCanRedo}
            onUndo={state.mode === 'animate' ? timelineUndo ?? undefined : undefined}
            onRedo={state.mode === 'animate' ? timelineRedo ?? undefined : undefined}
            onExport={() => setExportOpen(true)}
          />
          <StudioPanels
            projectId={projectId}
            mode={state.mode}
            library={
              <LibraryPanel
                projectId={projectId}
                assets={state.assets}
                filteredAssets={c.filteredAssets}
                activeCategory={state.activeCategory}
                onCategory={c.setCategory}
                query={state.query}
                onQuery={c.setQuery}
                activeAssetId={state.activeAssetId}
                onSelect={(id) => void c.selectAsset(id)}
                defaultSize={state.settings?.canvas}
                onCreate={async (input) => { await c.createAsset(input); }}
              />
            }
            frames={
              <FramesBrowserPanel
                projectId={projectId}
                assetId={state.activeAssetId ?? 0}
                currentVersionId={c.activeAsset?.currentVersionId ?? null}
                versions={av.versions}
                generations={av.generations}
                refresh={av.refresh}
                onSelectVersion={c.selectVersion}
                onImport={() => setImportOpen(true)}
              />
            }
            center={
              <CenterSurface
                mode={state.mode}
                projectId={projectId}
                settings={state.settings}
                activeAsset={c.activeAsset}
                activeVersion={activeVersion}
                versionById={av.versionById}
                generations={av.generations}
                refreshVersions={av.refresh}
                onSaved={onSaved}
                onSaveOverwrite={editSession || activeVersion ? onSaveOverwrite : undefined}
                overwritePrimary={!!editSession}
                onEngineReady={setEngine}
                iterateRef={pendingIterate}
                onIterateConsumed={() => setPendingIterate(null)}
                onEditVersion={onEditVersion}
                onExportAnimation={() => setExportOpen(true)}
                onFocusTab={onFocusTab}
                onCloseTab={(tab) => void onCloseTab(tab)}
              />
            }
            inspector={
              <InspectorPanel
                mode={state.mode}
                asset={c.activeAsset}
                versions={state.versions}
                activeVersionId={state.activeVersionId}
                onSelectVersion={c.selectVersion}
                onPatchAsset={c.patchAsset}
                onDeleteAsset={onDeleteAsset}
                onDeleteVersion={onDeleteVersion}
                onIterateVersion={onIterateVersion}
                settings={state.settings}
                onSaveSettings={c.saveSettings}
                engine={engine}
                projectId={projectId}
                generations={av.generations}
                versionById={av.versionById}
                refreshVersions={av.refresh}
                onEditVersion={(versionId, frameIndex, track) =>
                  onEditVersion(state.activeAssetId ?? 0, versionId, frameIndex, track)}
                onEditVersionInPlace={onEditVersionInPlace}
                onEnhanceApplied={onEnhanceApplied}
                editSession={editSession}
                onExitEditSession={() => setEditSession(null)}
              />
            }
          />
          <ExportDialog
            open={exportOpen}
            onClose={() => setExportOpen(false)}
            projectId={projectId}
            assets={state.assets}
            activeAsset={c.activeAsset}
            activeAnimation={state.mode === 'animate' && activeAnimation
              ? { id: activeAnimation.animationId, name: activeAnimation.name }
              : null}
          />
          {state.activeAssetId != null && (
            <ImportSheetDialog
              open={importOpen}
              onOpenChange={setImportOpen}
              projectId={projectId}
              assetId={state.activeAssetId}
              onImported={() => { av.refresh(); void c.refreshAssets(); c.setMode('animate'); }}
            />
          )}
        </>
      )}
      <StatusBarShell>
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${state.initialized ? 'bg-emerald-400' : 'bg-muted-foreground/50'}`} />
          <span className="max-w-[220px] truncate">{projectName ?? t('header.selectProject')}</span>
        </span>
        {state.initialized && (
          <>
            <span className="text-foreground/70">
              {state.mode === 'generate'
                ? t('toolbar.generate')
                : state.mode === 'animate'
                  ? t('toolbar.animate')
                  : t('toolbar.edit')}
            </span>
            <span>{state.assets.length} · {t('library.title')}</span>
            <span className="ml-auto max-w-[260px] truncate">
              {c.activeAsset
                ? `${c.activeAsset.name} · ${c.activeAsset.width}×${c.activeAsset.height}`
                : t('toolbar.noAsset')}
            </span>
          </>
        )}
      </StatusBarShell>
    </WorkbenchShell>
  );
}

/** Centered empty/CTA card used by the no-project and not-initialized states. */
function CenterCard({
  icon: Icon,
  title,
  body,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <span className="grid h-12 w-12 place-items-center rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-raised)]">
          <Icon className="h-6 w-6 text-muted-foreground" />
        </span>
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-muted-foreground">{body}</div>
        {children}
      </div>
    </div>
  );
}
