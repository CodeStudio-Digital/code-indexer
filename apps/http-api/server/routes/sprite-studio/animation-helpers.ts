/**
 * Shared bits of the animation routes: id→context resolution, the DTO
 * projection and input clamps. Split from animations.routes.ts for the
 * 200-LOC ceiling.
 */
import { normalizeTracks } from '@mcp/store/sprite-studio/track-settings.js';
import type { ServerDeps } from '../../deps.js';
import type {
  SpriteAnimationFileRow,
  SpriteAssetFileRow,
  SpriteFrameFileRow,
  SpriteProjectRuntimeRow,
} from '../../sprite-files.js';

/**
 * Frame-pack frames share ONE image row (n×1 strip). 12 keeps each cell wide
 * enough to read on a 1024px working image (~85px/cell); past ~12 the model's
 * per-pose adherence — not the slicer — is the real limiter, so 12 is the cap.
 */
export const MIN_FRAMES = 2;
export const MAX_FRAMES = 12;
export const LOOP_MODES: ReadonlySet<string> = new Set(['loop', 'once', 'pingpong']);

export const clampFrames = (n: unknown, fallback: number): number =>
  Math.max(MIN_FRAMES, Math.min(MAX_FRAMES, Math.round(typeof n === 'number' ? n : fallback)));

export const clampFps = (n: unknown, fallback: number): number =>
  Math.max(1, Math.min(60, Math.round(typeof n === 'number' ? n : fallback)));

/** Row + frame rows → the camelCase DTO the dashboard consumes (api-anim.ts). */
export function toAnimDto(anim: SpriteAnimationFileRow, frames: SpriteFrameFileRow[]): Record<string, unknown> {
  const frameCount = typeof anim.settings.frameCount === 'number' ? anim.settings.frameCount : null;
  const id = (v: unknown): string | null =>
    typeof v === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)
      ? v
      : null;
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  const baseCount = frames.filter((f) => f.track === 0).length;
  return {
    id: anim.id, assetId: anim.asset_id, name: anim.name, fps: anim.fps,
    loopMode: anim.loop_mode, status: anim.status,
    frameCount: baseCount > 0 ? baseCount : frameCount ?? 4,
    frames: frames.map((f) => ({
      id: f.id, frameIndex: f.frame_index, versionId: f.version_id, durationMs: f.duration_ms,
      track: f.track,
    })),
    // Layer metadata — Base/track 0 always present (normalizer injects it).
    tracks: normalizeTracks(anim.settings),
    // Deep provenance: which version anchored generation + which job the
    // current frames were adopted from (both live in settings_json).
    anchorVersionId: id(anim.settings.anchorVersionId),
    lastGenJobId: id(anim.settings.lastGenJobId),
    // Playback loop range (scrubber markers, frame indices) — null = whole clip.
    loopStart: num(anim.settings.loopStart),
    loopEnd: num(anim.settings.loopEnd),
    actionKey: typeof anim.settings.actionKey === 'string' ? anim.settings.actionKey : anim.name,
    direction: typeof anim.settings.direction === 'string' ? anim.settings.direction : null,
    exportName: typeof anim.settings.exportName === 'string' ? anim.settings.exportName : anim.name,
    pivot: anim.settings.pivot && typeof anim.settings.pivot === 'object' ? anim.settings.pivot : { x: 0.5, y: 1 },
    createdAt: anim.created_at, updatedAt: anim.updated_at,
  };
}

/**
 * Resolve the identity-anchor version for frame generation. `requested` is
 * the raw body value: a number must name a version OF THE ANIMATION'S ASSET
 * (anything else → {ok:false} → 400); absent/null falls back to the asset's
 * current version (or none — generation then runs unconditioned).
 */
export async function pickAnchorVersion<V extends { id: string; asset_id: string }>(
  getVersion: (id: string) => Promise<V | null | undefined> | V | null | undefined,
  assetId: string,
  currentVersionId: string | null,
  requested: unknown,
): Promise<{ ok: false } | { ok: true; version: V | null; explicit: boolean }> {
  if (requested !== undefined && requested !== null) {
    if (typeof requested !== 'string') return { ok: false };
    const version = await getVersion(requested) ?? null;
    if (!version || version.asset_id !== assetId) return { ok: false };
    return { ok: true, version, explicit: true };
  }
  const current =
    currentVersionId != null ? await getVersion(currentVersionId) ?? null : null;
  return { ok: true, version: current && current.asset_id === assetId ? current : null, explicit: false };
}

export interface AnimContext {
  anim: SpriteAnimationFileRow;
  asset: SpriteAssetFileRow;
  spriteProject: SpriteProjectRuntimeRow;
  root: string | null;
}

/** Everything an /animations/:id handler needs, resolved from the id alone. */
export async function resolveAnim(
  deps: ServerDeps,
  animationId: string,
): Promise<AnimContext | null> {
  return deps.spriteFileStore.resolveAnimation(animationId);
}
