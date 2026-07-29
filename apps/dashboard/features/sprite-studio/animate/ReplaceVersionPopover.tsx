/**
 * "Substituir" popover of a timeline frame cell — a thin verb-specific
 * wrapper over the shared VersionPickerPopover (which owns the lazy fetch +
 * thumb grid): picking a version repoints THE FRAME at it, committed by the
 * parent through the debounced PATCH path.
 */
import { useTranslation } from 'react-i18next';
import { VersionPickerPopover } from './VersionPickerPopover.js';

export function ReplaceVersionPopover({ projectId, assetId, currentVersionId, onPick, children }: {
  projectId: number;
  assetId: string;
  /** The frame's version — highlighted so the user sees what it points at now. */
  currentVersionId: string;
  onPick: (versionId: string) => void;
  /** Trigger element (the frame cell's replace icon button). */
  children: React.ReactNode;
}) {
  const { t } = useTranslation('spriteStudio');
  return (
    <VersionPickerPopover
      projectId={projectId}
      assetId={assetId}
      currentVersionId={currentVersionId}
      title={t('animate.timeline.replaceTitle')}
      onPick={onPick}
    >
      {children}
    </VersionPickerPopover>
  );
}
