/**
 * DataTransfer helpers for dragging ASSET VERSIONS (inspector Versions list)
 * onto other studio surfaces — today the animation TimelineStrip (drop on a
 * frame = repoint it, drop on the tail = append a frame). Mirrors
 * library/asset-drag.ts: a custom MIME type keeps OS/file drops apart, and
 * the payload carries ids only (Electron's sandbox strips file paths).
 */
export const SPRITE_VERSION_MIME = 'application/x-sprite-version';

export interface SpriteVersionDragPayload {
  versionId: number;
  /** Owning asset — drop targets MUST reject payloads from another asset. */
  assetId: number;
  /** Sequential version number (v013 label material). */
  version: number;
  /** Preformatted label, e.g. "v013". */
  label: string;
}

/** Attach a version to a drag operation (a frame COPIES the pointer). */
export function setVersionDragData(dt: DataTransfer, payload: SpriteVersionDragPayload): void {
  dt.setData(SPRITE_VERSION_MIME, JSON.stringify(payload));
  dt.effectAllowed = 'copy';
}

/** True when a drag carries a version (readable during dragover — data isn't). */
export function hasVersionDragData(dt: DataTransfer): boolean {
  return Array.from(dt.types).includes(SPRITE_VERSION_MIME);
}

/** Read the payload back on drop; null when absent or malformed. */
export function readVersionDragData(dt: DataTransfer): SpriteVersionDragPayload | null {
  try {
    const raw = dt.getData(SPRITE_VERSION_MIME);
    if (!raw) return null;
    const o = JSON.parse(raw) as Partial<SpriteVersionDragPayload>;
    if (!Number.isInteger(o.versionId) || !Number.isInteger(o.assetId)) return null;
    if (!Number.isInteger(o.version) || typeof o.label !== 'string') return null;
    return {
      versionId: o.versionId,
      assetId: o.assetId,
      version: o.version,
      label: o.label,
    };
  } catch {
    return null;
  }
}
