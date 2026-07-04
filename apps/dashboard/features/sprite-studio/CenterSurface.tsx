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
  onEngineReady,
  iterateRef,
  onIterateConsumed,
  onEditVersion,
}: {
  mode: StudioMode;
  projectId: number;
  settings: StudioSettings | null;
  activeAsset: SpriteAsset | null;
  activeVersion: AssetVersion | null;
  /** Shared version lookup + refresh (lifted useAssetVersions) for animate. */
  versionById: Map<number, AssetVersion>;
  /** Generation batches of the active asset (re-slice affordance). */
  generations: GenerationGroup[];
  refreshVersions: () => void;
  /** (assetId, versionId) after a generation is saved OR an edit is committed. */
  onSaved: (assetId: number, versionId: number) => void;
  /** Focused edit session active → EditModeView primary save = overwrite. */
  onSaveOverwrite?: (blob: Blob) => void | Promise<void>;
  onEngineReady: (engine: EditorEngine | null) => void;
  /** "Iterate from this" request (version list) routed into the generate panel. */
  iterateRef?: IterateRef | null;
  onIterateConsumed?: () => void;
  /** Timeline "edit frame": select that version + jump to edit mode. */
  onEditVersion?: (assetId: number, versionId: number) => void;
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
    if (!activeAsset) {
      return (
        <EmptyState icon={Brush} title={t('edit.noAssetTitle')} body={t('edit.noAssetBody')} />
      );
    }
    return (
      <EditModeView
        projectId={projectId}
        asset={activeAsset}
        activeVersion={activeVersion}
        onEngineReady={onEngineReady}
        onSaveOverwrite={onSaveOverwrite}
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
          onEditVersion={onEditVersion ? (vid) => onEditVersion(activeAsset.id, vid) : undefined}
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
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <Icon className="h-8 w-8 text-muted-foreground/40" />
      <div className="text-sm font-medium">{title}</div>
      <div className="max-w-sm text-xs text-muted-foreground">{body}</div>
    </div>
  );
}
