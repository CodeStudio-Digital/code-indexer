/**
 * Center-pane router: dispatches the studio mode to its real surface —
 * GeneratePanel (generate) or EditModeView (edit). Export opens as a dialog
 * from the toolbar, not a center mode. Kept out of SpriteStudioView so the
 * shell stays lean and the two mode surfaces can evolve independently.
 */
import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Brush, Film, ImageOff, Loader2 } from 'lucide-react';
import type { EditorEngine } from './engine/EditorEngine.js';
import { GeneratePanel, type IterateRef } from './generate/GeneratePanel.js';
import { EditModeView } from './edit/EditModeView.js';
import { EditorTabBar } from './edit/EditorTabBar.js';
import { editorTabKey, type EditorTab } from './edit/editor-tabs.js';
import { saveEditedVersion } from './api.js';
import { startInpaintJob } from './api-enhance.js';
import type { GenerationGroup } from './animate/api-anim-bulk.js';
import type { AssetVersion, SpriteAsset, StudioMode, StudioSettings } from './types.js';

// Phase-2 surface (timeline/frames) — lazy so the animation stack never
// weighs on the main studio chunk.
const AnimatePanel = lazy(() =>
  import('./animate/AnimatePanel.js').then((m) => ({ default: m.AnimatePanel })),
);

export function CenterSurface({
  mode,
  projectId,
  settings,
  activeAsset,
  activeVersion,
  versionById,
  generations,
  refreshVersions,
  onSaved,
  onSaveOverwrite,
  overwritePrimary,
  onEngineReady,
  iterateRef,
  onIterateConsumed,
  onEditVersion,
  onExportAnimation,
  onFocusTab,
  onCloseTab,
}: {
  mode: StudioMode;
  projectId: number;
  settings: StudioSettings | null;
  activeAsset: SpriteAsset | null;
  activeVersion: AssetVersion | null;
  /** Shared version lookup + refresh (lifted useAssetVersions) for animate. */
  versionById: Map<string, AssetVersion>;
  /** Generation batches of the active asset (re-slice affordance). */
  generations: GenerationGroup[];
  refreshVersions: () => void;
  /** (assetId, versionId) after a generation is saved OR an edit is committed. */
  onSaved: (assetId: string, versionId: string) => void;
  /** Overwrite-in-place handler — present whenever there's a version to save
   *  over (focused session OR the normal editor). */
  onSaveOverwrite?: (blob: Blob) => void | Promise<void>;
  /** True only in a focused edit session — makes overwrite the primary save
   *  (and skips the confirm). In the normal editor, "save as new" is primary
   *  and overwrite prompts for confirmation (it mutates a shared version). */
  overwritePrimary?: boolean;
  onEngineReady: (engine: EditorEngine | null) => void;
  /** "Iterate from this" request (version list) routed into the generate panel. */
  iterateRef?: IterateRef | null;
  onIterateConsumed?: () => void;
  /** Timeline "edit frame": select that version + jump to edit mode. */
  onEditVersion?: (assetId: string, versionId: string, frameIndex: number, track: number) => void;
  /** Contextual animation export opens the shared export dialog pre-scoped. */
  onExportAnimation?: () => void;
  /** Multi-tab editor: focus / close an open image tab. */
  onFocusTab?: (tab: EditorTab) => void;
  onCloseTab?: (tab: EditorTab) => void;
}) {
  const { t } = useTranslation('spriteStudio');

  if (mode === 'generate') {
    return (
      <GeneratePanel
        projectId={projectId}
        settings={settings}
        activeAsset={activeAsset}
        onSaved={onSaved}
        iterateRef={iterateRef}
        onIterateConsumed={onIterateConsumed}
      />
    );
  }

  if (mode === 'edit') {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <EditorTabBar
          projectId={projectId}
          activeKey={activeAsset ? editorTabKey(activeAsset.id, activeVersion?.id ?? null) : null}
          onFocus={(tab) => onFocusTab?.(tab)}
          onClose={(tab) => onCloseTab?.(tab)}
        />
        {!activeAsset ? (
          <EmptyState icon={Brush} title={t('edit.noAssetTitle')} body={t('edit.noAssetBody')} />
        ) : (
          <div className="min-h-0 flex-1">
            <EditModeView
              projectId={projectId}
              asset={activeAsset}
              activeVersion={activeVersion}
              onEngineReady={onEngineReady}
              onSaveOverwrite={onSaveOverwrite}
              overwritePrimary={overwritePrimary}
              onSaveEdited={async (blob) => {
                const version = await saveEditedVersion(projectId, activeAsset.id, blob);
                if (version) onSaved(activeAsset.id, version.id);
              }}
              onInpaint={
                activeVersion
                  ? async (mask, prompt) => {
                      await startInpaintJob(projectId, activeAsset.id, activeVersion.id, mask, prompt);
                    }
                  : undefined
              }
            />
          </div>
        )}
      </div>
    );
  }

  if (mode === 'animate') {
    if (!activeAsset) {
      return <EmptyState icon={Film} title={t('edit.noAssetTitle')} body={t('edit.noAssetBody')} />;
    }
    return (
      <Suspense fallback={<div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>}>
        <AnimatePanel
          projectId={projectId}
          asset={activeAsset}
          settings={settings}
          versionById={versionById}
          generations={generations}
          refreshVersions={refreshVersions}
          onSaved={onSaved}
          onEditVersion={onEditVersion
            ? (versionId, frameIndex, track) => onEditVersion(activeAsset.id, versionId, frameIndex, track)
            : undefined}
          onExportAnimation={onExportAnimation}
        />
      </Suspense>
    );
  }

  return <EmptyState icon={ImageOff} title={t('placeholder.editTitle')} body={t('placeholder.editBody')} />;
}

function EmptyState({
  icon: Icon,
  title,
  body,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-[var(--workbench-canvas)] p-6 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-raised)]">
        <Icon className="h-6 w-6 text-muted-foreground" />
      </span>
      <div className="space-y-1">
        <div className="text-sm font-medium">{title}</div>
        <div className="max-w-sm text-xs leading-5 text-muted-foreground">{body}</div>
      </div>
    </div>
  );
}
