/**
 * Sprite Studio — top-level route view (`/sprites`). A standalone surface
 * like the DS Studio (NOT a ProjectView tab): it carries its own project
 * selector in the header, a CTA to initialize `.sprite-studio/` on first
 * use, and then the studio shell (toolbar + library | center | inspector).
 * Deep-link: `/sprites?project=<id>`; the last project is remembered.
 */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronDown, FolderOpen, ImagePlay, Loader2 } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu.js';
import { useApi } from '../../hooks/useApi.js';
import * as api from './api.js';
import { useSpriteStudio } from './useSpriteStudio.js';
import { disposeEngine, engineKey } from './engine/engine-registry.js';
import { loadLastSpriteProject, saveLastSpriteProject } from './sprite-studio-ui-state.js';
import { StudioToolbar } from './StudioToolbar.js';
import { LibraryPanel } from './library/LibraryPanel.js';
import { InspectorPanel } from './inspector/InspectorPanel.js';
import { CenterSurface } from './CenterSurface.js';
import { StudioPanels } from './panels/StudioPanels.js';
import { ExportDialog } from './export/ExportDialog.js';
import { ModelSelector } from './ModelSelector.js';
import { useAssetVersions } from './animate/useAssetVersions.js';
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
  const [editSession, setEditSession] = useState<{ versionId: number; origin: 'frame' | 'version' } | null>(null);

  // Single lifted version+generation fetch shared by all three animate rails
  // (center provenance, LEFT Frames browser, RIGHT FrameInspector).
  const av = useAssetVersions(projectId ?? 0, state.activeAssetId ?? 0);

  // Reset the cross-rail selection/bridge whenever the focused asset changes.
  useEffect(() => {
    useAnimateSession.getState().resetForAsset();
    setEditSession(null);
  }, [projectId, state.activeAssetId]);

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
  const activeVersion = useMemo(
    () => state.versions.find((v) => v.id === state.activeVersionId) ?? null,
    [state.versions, state.activeVersionId],
  );
  // After a generation is saved or an edit committed, refresh + focus the asset.
  const onSaved = (assetId: number) => { void c.refreshAssets(); void c.selectAsset(assetId); };

  // Timeline "edit frame": open that exact version in a FOCUSED session —
  // the primary save overwrites it in place, so the frame updates visually.
  const onEditVersion = (_assetId: number, versionId: number) => {
    c.selectVersion(versionId);
    setEditSession({ versionId, origin: 'frame' });
    c.setMode('edit');
  };

  // Versions-list pencil: same focused session, but returning stays in edit.
  const onEditVersionInPlace = (versionId: number) => {
    c.selectVersion(versionId);
    setEditSession({ versionId, origin: 'version' });
    c.setMode('edit');
  };

  // "Salvar Sprite": PUT the canvas over the SAME version file, refresh every
  // consumer (thumbs bust via contentHash) and hop back where the user came from.
  const onSaveOverwrite = async (blob: Blob) => {
    if (projectId == null || !editSession) return;
    await api.overwriteVersion(projectId, editSession.versionId, blob);
    av.refresh();
    await c.refreshAssets();
    if (state.activeAssetId != null) void c.selectAsset(state.activeAssetId);
    const origin = editSession.origin;
    setEditSession(null);
    if (origin === 'frame') c.setMode('animate');
  };

  const onDeleteAsset = async (assetId: number) => {
    if (projectId == null) return;
    await api.deleteAsset(projectId, assetId);
    disposeEngine(engineKey(projectId, assetId));
    await c.refreshAssets();
    void c.selectAsset(null);
  };

  const onDeleteVersion = async (versionId: number) => {
    if (projectId == null || state.activeAssetId == null) return;
    await api.deleteVersion(projectId, versionId);
    await c.refreshAssets();
    void c.selectAsset(state.activeAssetId); // reload the version list
    av.refresh(); // keep the shared Frames-browser view in sync
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3 text-xs">
        <ImagePlay className="h-4 w-4 shrink-0" />
        <span className="font-medium">{t('title')}</span>
        <span className="h-4 w-px bg-border" />
        <span className="text-muted-foreground">{t('header.projectLabel')}</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" className="h-7 max-w-[240px] gap-1">
              <FolderOpen className="h-3.5 w-3.5 shrink-0" />
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
          <span className="text-muted-foreground">{t('model.label')}</span>
          <ModelSelector />
        </div>
      </div>

      {projectId == null ? (
        <CenterCard icon={FolderOpen} title={t('header.selectProject')} body={t('header.selectProjectHint')} />
      ) : state.loading ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : state.error ? (
        <div className="m-3 rounded border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-400">
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
                onSaveOverwrite={editSession ? onSaveOverwrite : undefined}
                onEngineReady={setEngine}
                iterateRef={pendingIterate}
                onIterateConsumed={() => setPendingIterate(null)}
                onEditVersion={onEditVersion}
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
                onEditVersion={(vid) => onEditVersion(state.activeAssetId ?? 0, vid)}
                onEditVersionInPlace={onEditVersionInPlace}
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
    </div>
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
      <div className="flex max-w-md flex-col items-center gap-3 rounded-lg border border-dashed p-8 text-center">
        <Icon className="h-8 w-8 text-muted-foreground/40" />
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-muted-foreground">{body}</div>
        {children}
      </div>
    </div>
  );
}

