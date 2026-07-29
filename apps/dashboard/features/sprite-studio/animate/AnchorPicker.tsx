/**
 * Anchor selector of the generate bar: WHICH version conditions the character
 * identity of the next frame-pack generation ("a partir de qual versão").
 * A compact button (thumb + v-label, or "atual" = the asset's current) opens
 * the shared VersionPickerPopover; the choice is sent as anchorVersionId on
 * the next generate and persisted server-side. A provenance line shows the
 * stored anchor + the last adopted generation job.
 */
import { useTranslation } from 'react-i18next';
import { Anchor } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { versionThumbUrl } from '../api.js';
import type { AssetVersion } from '../types.js';
import { VersionPickerPopover } from './VersionPickerPopover.js';

const vLabel = (n: number): string => `v${String(n).padStart(3, '0')}`;

export function AnchorPicker({
  projectId, assetId, anchorVersionId, lastGenJobId, versionById, disabled, onChange,
}: {
  projectId: number;
  assetId: string;
  /** Local draft (hydrated from the server AnimDto); null = asset's current. */
  anchorVersionId: string | null;
  /** Job that produced the current frames (settings.lastGenJobId); null = none. */
  lastGenJobId: string | null;
  versionById: Map<string, AssetVersion>;
  disabled?: boolean;
  onChange: (versionId: string | null) => void;
}) {
  const { t } = useTranslation('spriteStudio');
  const anchor = anchorVersionId != null ? versionById.get(anchorVersionId) : undefined;
  const label = anchorVersionId == null
    ? t('animate.anchor.current')
    : anchor ? vLabel(anchor.version) : `#${anchorVersionId}`;
  const provenance = [
    anchorVersionId != null ? t('animate.anchor.anchoredAt', { v: label }) : null,
    lastGenJobId != null ? t('animate.anchor.lastJob', { id: lastGenJobId }) : null,
  ].filter(Boolean).join(' · ');

  return (
    <>
      <VersionPickerPopover
        projectId={projectId}
        assetId={assetId}
        currentVersionId={anchorVersionId}
        title={t('animate.anchor.pickTitle')}
        onPick={(id) => onChange(id)}
        clearLabel={t('animate.anchor.useCurrent')}
        onClear={() => onChange(null)}
      >
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 px-2 text-[11px]"
          disabled={disabled}
          title={t('animate.anchor.hint')}
        >
          <Anchor className="h-3 w-3" />
          {anchorVersionId != null && (
            <img
              src={versionThumbUrl(projectId, anchorVersionId, 32)}
              alt=""
              className="h-4 w-4 rounded-sm object-contain"
              style={{ imageRendering: 'pixelated' }}
              draggable={false}
            />
          )}
          {`${t('animate.anchor.label')}: ${label}`}
        </Button>
      </VersionPickerPopover>
      {provenance && (
        <span className="text-[10px] tabular-nums text-muted-foreground" title={t('animate.anchor.hint')}>
          {provenance}
        </span>
      )}
    </>
  );
}
