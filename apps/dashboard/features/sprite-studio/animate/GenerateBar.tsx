/**
 * Generate toolbar row of the AnimatePanel (extracted for the 200-LOC
 * ceiling): the frame-pack generate/regenerate button, the direction select,
 * the AnchorPicker (which version conditions the character + provenance
 * line) and the live job-status label. All state lives in AnimatePanel —
 * this row is a pure projection.
 */
import { useTranslation } from 'react-i18next';
import { Clapperboard, Loader2, Scissors } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import type { AssetVersion } from '../types.js';
import { AnchorPicker } from './AnchorPicker.js';
import { FrameCountStepper } from './FrameCountStepper.js';

const DIRECTIONS = ['', 'S', 'N', 'E', 'W', 'side'] as const;

export function GenerateBar({
  projectId, assetId, running, adopting, hasFrames, direction, genStatus,
  anchorVersionId, lastGenJobId, versionById, frameCount, canReslice,
  onDirection, onAnchorChange, onGenerate, onFrameCount, onReslice,
}: {
  projectId: number;
  assetId: number;
  running: boolean;
  adopting: boolean;
  hasFrames: boolean;
  direction: string;
  /** Non-terminal job progress; null while idle / failed / done. */
  genStatus: { status: string; pct: number } | null;
  anchorVersionId: number | null;
  lastGenJobId: number | null;
  versionById: Map<number, AssetVersion>;
  /** Target frame count for the next (re)generation (2..12). */
  frameCount: number;
  /** The last generation kept its original sheet — re-slice available. */
  canReslice: boolean;
  onDirection: (d: string) => void;
  onAnchorChange: (versionId: number | null) => void;
  onGenerate: () => void;
  onFrameCount: (n: number) => void;
  onReslice: () => void;
}) {
  const { t } = useTranslation('spriteStudio');
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" className="h-7 gap-1 px-2 text-[11px]" disabled={running} onClick={onGenerate}>
        {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Clapperboard className="h-3 w-3" />}
        {running
          ? adopting ? t('animate.adopting') : t('animate.generating')
          : hasFrames ? t('animate.regenerate') : t('animate.generate')}
      </Button>
      <FrameCountStepper value={frameCount} disabled={running} onChange={onFrameCount} />
      {canReslice && (
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 px-2 text-[11px]"
          disabled={running}
          title={t('frames.reslice')}
          onClick={onReslice}
        >
          <Scissors className="h-3 w-3" /> {t('frames.resliceShort')}
        </Button>
      )}
      <select
        className="h-7 rounded border bg-background px-2 text-xs"
        value={direction}
        aria-label={t('animate.direction')}
        onChange={(e) => onDirection(e.target.value)}
      >
        {DIRECTIONS.map((d) => (
          <option key={d} value={d}>{d === '' ? t('animate.dirNone') : t(`animate.dir.${d}`)}</option>
        ))}
      </select>
      <AnchorPicker
        projectId={projectId}
        assetId={assetId}
        anchorVersionId={anchorVersionId}
        lastGenJobId={lastGenJobId}
        versionById={versionById}
        disabled={running}
        onChange={onAnchorChange}
      />
      {genStatus && (
        <span className="text-[10px] tabular-nums text-muted-foreground">
          {t(`animate.jobStatus.${genStatus.status}`, { defaultValue: genStatus.status })}
          {genStatus.pct > 0 ? ` · ${genStatus.pct}%` : ''}
        </span>
      )}
      <span className="ml-auto text-[10px] text-muted-foreground">{t('animate.generateHint')}</span>
    </div>
  );
}
