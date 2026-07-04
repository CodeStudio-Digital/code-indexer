/**
 * DataTransfer helpers for dragging library assets into other studio
 * surfaces (e.g. generation reference slots). Uses a custom MIME type so
 * drops from the OS / other apps can't be confused with library drags —
 * and because Electron's modern sandbox strips `file.path`, in-app drags
 * must carry ids, never filesystem paths.
 */
export const SPRITE_ASSET_MIME = 'application/x-sprite-asset';

export interface SpriteAssetDragPayload {
  assetId: number;
  slug: string;
  versionId?: number | null;
  thumbUrl?: string | null;
}

/** Attach a library asset to a drag operation. */
export function setAssetDragData(dt: DataTransfer, payload: SpriteAssetDragPayload): void {
  dt.setData(SPRITE_ASSET_MIME, JSON.stringify(payload));
  dt.effectAllowed = 'copy';
}

/** True when a drag carries a library asset (usable in dragover handlers). */
export function hasAssetDragData(dt: DataTransfer): boolean {
  return Array.from(dt.types).includes(SPRITE_ASSET_MIME);
}

/** Read the payload back on drop; null when absent or malformed. */
export function readAssetDragData(dt: DataTransfer): SpriteAssetDragPayload | null {
  try {
    const raw = dt.getData(SPRITE_ASSET_MIME);
    if (!raw) return null;
    const o = JSON.parse(raw) as Partial<SpriteAssetDragPayload>;
    if (typeof o.assetId !== 'number' || typeof o.slug !== 'string') return null;
    return { assetId: o.assetId, slug: o.slug, versionId: o.versionId ?? null, thumbUrl: o.thumbUrl ?? null };
  } catch {
    return null;
  }
}
