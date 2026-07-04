/**
 * Right inspector panel — cards routed by studio mode (plan §3.2).
 * Generate mode: StyleSettings (edit the project style contract) + GenParams
 * summary. Edit mode: Layers (add/merge/reorder on the live doc) + Palette
 * (extract → swatches) + Adjustments (local ops on the live engine). Both
 * modes keep the asset-meta + versions cards below.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MousePointerSquareDashed } from 'lucide-react';
import type { EditorEngine } from '../engine/EditorEngine.js';
import type { AssetVersion, SpriteAsset, StudioMode, StudioSettings } from '../types.js';
import { FrameInspector } from '../animate/FrameInspector.js';
import type { GenerationGroup } from '../animate/api-anim-bulk.js';
import { LayerList } from '../edit/LayerList.js';
import { AssetMetaCard } from './AssetMetaCard.js';
import { VersionsPanel } from './VersionsPanel.js';
import { StyleSettingsCard } from './StyleSettingsCard.js';
import { GenParamsCard } from './GenParamsCard.js';
import { AdjustmentsCard } from './AdjustmentsCard.js';
import { PaletteCard } from './PaletteCard.js';
import { EnhanceCard } from './EnhanceCard.js';

export function InspectorPanel({
  mode,
  asset,
  versions,
  activeVersionId,
  onSelectVersion,
  onPatchAsset,
  onDeleteAsset,
  onDeleteVersion,
  onIterateVersion,
  settings,
  onSaveSettings,
  engine,
  projectId,
  generations,
  versionById,
  refreshVersions,
  onEditVersion,
}: {
  mode: StudioMode;
  asset: SpriteAsset | null;
  versions: AssetVersion[];
  activeVersionId: number | null;
  onSelectVersion: (versionId: number) => void;
  onPatchAsset: (assetId: number, patch: Partial<SpriteAsset>) => Promise<void>;
  onDeleteAsset?: (assetId: number) => void | Promise<void>;
  onDeleteVersion?: (versionId: number) => void | Promise<void>;
  onIterateVersion?: (versionId: number, label: string) => void;
  settings: StudioSettings | null;
  onSaveSettings: (next: StudioSettings) => void | Promise<void>;
  engine: EditorEngine | null;
  /** IDE project id for the AI enhance card and the version preview
   *  (optional — the enhance card can self-resolve; the preview hides). */
  projectId?: number;
  // Animate mode: the shared version data + frame actions for FrameInspector.
  generations?: GenerationGroup[];
  versionById?: Map<number, AssetVersion>;
  refreshVersions?: () => void;
  onEditVersion?: (versionId: number) => void;
}) {
  const { t } = useTranslation('spriteStudio');
  // Palette locked in the Palette card feeds the Adjustments quantize op.
  const [lockedPalette, setLockedPalette] = useState<string[] | null>(null);

  // Animate mode gets a bespoke frame-centric inspector (replaces the flat
  // Versions list); it self-manages selection + bulk ops via the session store.
  if (mode === 'animate') {
    if (!asset || projectId == null) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted-foreground">
          <MousePointerSquareDashed className="h-5 w-5 opacity-50" />
          {t('inspector.empty')}
        </div>
      );
    }
    return (
      <FrameInspector
        projectId={projectId}
        versionById={versionById ?? new Map()}
        generations={generations ?? []}
        refresh={refreshVersions ?? (() => {})}
        onEditVersion={onEditVersion ?? (() => {})}
        onSelectVersion={onSelectVersion}
      />
    );
  }

  // Generate mode surfaces the style contract even with no asset selected.
  const modeCards =
    mode === 'generate' ? (
      <>
        {settings && <StyleSettingsCard settings={settings} onSaveSettings={onSaveSettings} />}
        <GenParamsCard params={null} />
      </>
    ) : mode === 'edit' ? (
      <>
        {engine && <LayerList engine={engine} />}
        <PaletteCard engine={engine} onPaletteChange={setLockedPalette} />
        <AdjustmentsCard engine={engine} palette={lockedPalette ?? undefined} />
        <EnhanceCard projectId={projectId} asset={asset} activeVersionId={activeVersionId} />
      </>
    ) : null;

  if (!asset) {
    return (
      <div className="h-full space-y-2 overflow-y-auto p-2">
        {modeCards}
        <div className="flex flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted-foreground">
          <MousePointerSquareDashed className="h-5 w-5 opacity-50" />
          {t('inspector.empty')}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full space-y-2 overflow-y-auto p-2">
      {modeCards}
      <AssetMetaCard asset={asset} onPatch={onPatchAsset} onDelete={onDeleteAsset} />
      <VersionsPanel
        versions={versions}
        currentVersionId={asset.currentVersionId}
        activeVersionId={activeVersionId}
        onSelect={onSelectVersion}
        onDelete={onDeleteVersion}
        onIterate={onIterateVersion}
        projectId={projectId}
      />
    </div>
  );
}
