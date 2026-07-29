/**
 * Track (animation layer) metadata helpers — pure functions over
 * each animation entity's `settings.tracks`. Track 0 ("Base") is NEVER
 * materialized until the user edits tracks: `normalizeTracks` injects it on
 * read, so legacy animations need zero backfill and there is exactly one
 * normalization choke point. Track ids are max+1 (id reuse after delete is
 * safe — the rows die with the track).
 */
import type { SpriteTrackMeta } from './types.js';

/** Hard cap — the preview/GIF composite envelope (route returns 400 beyond). */
export const MAX_TRACKS = 4;

const BASE: SpriteTrackMeta = { id: 0, name: 'Base', visible: true };

/** Read tracks from settings: always includes track 0, sorted by id. */
export function normalizeTracks(settings: Record<string, unknown>): SpriteTrackMeta[] {
  const raw = Array.isArray(settings.tracks) ? settings.tracks : [];
  const out = new Map<number, SpriteTrackMeta>();
  out.set(0, { ...BASE });
  for (const t of raw) {
    const o = t as Partial<SpriteTrackMeta>;
    if (typeof o.id !== 'number' || !Number.isInteger(o.id) || o.id < 0) continue;
    out.set(o.id, {
      id: o.id,
      name: typeof o.name === 'string' && o.name.trim() ? o.name.slice(0, 40) : `Layer ${o.id}`,
      visible: o.visible !== false,
    });
  }
  return [...out.values()].sort((a, b) => a.id - b.id);
}

/** Add a layer; returns the new list + its id, or null at the MAX_TRACKS cap. */
export function addTrack(
  settings: Record<string, unknown>,
  name?: string,
): { tracks: SpriteTrackMeta[]; newId: number } | null {
  const tracks = normalizeTracks(settings);
  if (tracks.length >= MAX_TRACKS) return null;
  const newId = Math.max(...tracks.map((t) => t.id)) + 1;
  const next = [...tracks, { id: newId, name: name?.trim().slice(0, 40) || `Layer ${newId}`, visible: true }];
  return { tracks: next, newId };
}

/** Rename / toggle visibility. Null when the track id is unknown. */
export function patchTrack(
  settings: Record<string, unknown>,
  trackId: number,
  patch: { name?: string; visible?: boolean },
): SpriteTrackMeta[] | null {
  const tracks = normalizeTracks(settings);
  const idx = tracks.findIndex((t) => t.id === trackId);
  if (idx < 0) return null;
  const next = [...tracks];
  next[idx] = {
    ...next[idx],
    ...(patch.name !== undefined && patch.name.trim() ? { name: patch.name.trim().slice(0, 40) } : {}),
    ...(patch.visible !== undefined ? { visible: patch.visible } : {}),
  };
  return next;
}

/** Remove a layer (its frame rows are the caller's job). Track 0 is immutable. */
export function removeTrack(
  settings: Record<string, unknown>,
  trackId: number,
): SpriteTrackMeta[] | null {
  if (trackId === 0) return null;
  const tracks = normalizeTracks(settings);
  if (!tracks.some((t) => t.id === trackId)) return null;
  return tracks.filter((t) => t.id !== trackId);
}
