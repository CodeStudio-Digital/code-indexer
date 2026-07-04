/**
 * One thumb row of a group in the Frames browser — a fixed-column grid of
 * VersionMiniThumb tiles (the browser chunks a group's versions into these
 * rows for virtualization). Kept tiny so the browser row renderer stays lean.
 */
import type { AssetVersion } from '../../types.js';
import { VersionMiniThumb } from './VersionMiniThumb.js';

export function VersionMiniGrid({
  projectId,
  versions,
  cols,
  currentVersionId,
  onThumbClick,
}: {
  projectId: number;
  versions: AssetVersion[];
  cols: number;
  currentVersionId: number | null;
  onThumbClick: (id: number, e: React.MouseEvent) => void;
}) {
  return (
    <div
      className="grid gap-1.5 px-2 py-1"
      style={{ gridTemplateColumns: `repeat(${Math.max(1, cols)}, minmax(0, 1fr))` }}
    >
      {versions.map((v) => (
        <VersionMiniThumb
          key={v.id}
          projectId={projectId}
          version={v}
          isCurrent={v.id === currentVersionId}
          onClick={onThumbClick}
        />
      ))}
    </div>
  );
}
