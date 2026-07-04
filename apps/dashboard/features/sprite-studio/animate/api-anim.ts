/**
 * Animation API — fetch wrappers over the animation routes
 * (apps/http-api/server/routes/sprite-studio/animations.routes.ts). Lives
 * beside AnimatePanel instead of api.ts so the animation slice never
 * contends on that file. Same direct-fetch pattern against `apiBaseUrl()`.
 */
import { apiBaseUrl } from '../../../lib/api-client.js';

export type AnimLoopMode = 'loop' | 'once' | 'pingpong';

export interface AnimFrame {
  id: number;
  frameIndex: number;
  versionId: number;
  /** Per-frame override; null = 1000/fps. Only track 0 carries durations. */
  durationMs: number | null;
  /** Animation layer (0 = Base); cells compose bottom-up by ascending track. */
  track: number;
}

/** Animation-layer metadata (track 0 "Base" always present). */
export interface TrackMeta {
  id: number;
  name: string;
  visible: boolean;
}

export interface SpriteAnimation {
  id: number;
  assetId: number;
  name: string;
  fps: number;
  loopMode: AnimLoopMode;
  status: string;
  /** Target frame count for generation (frames.length once frames exist). */
  frameCount: number;
  frames: AnimFrame[];
  /** Animation layers, id-ascending (bottom-up compositing order). */
  tracks: TrackMeta[];
  /** Version that anchored the last generation; null = asset's current. */
  anchorVersionId: number | null;
  /** Job whose candidates were last adopted as frames; null = never. */
  lastGenJobId: number | null;
  /** Playback loop range (frame indices); null = whole clip. */
  loopStart: number | null;
  loopEnd: number | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * HAND-KEPT MIRROR of the backend action catalog
 * (packages/sprite-studio/src/jobs/action-catalog.ts) — the dashboard never
 * imports backend packages, so edit both lists together.
 */
export interface ActionPreset { action: string; frames: number; fps: number; loopMode: AnimLoopMode }
export const ACTION_PRESETS: readonly ActionPreset[] = [
  { action: 'idle',   frames: 4, fps: 8,  loopMode: 'loop' },
  { action: 'walk',   frames: 6, fps: 8,  loopMode: 'loop' },
  { action: 'run',    frames: 6, fps: 10, loopMode: 'loop' },
  { action: 'attack', frames: 4, fps: 12, loopMode: 'once' },
  { action: 'hit',    frames: 2, fps: 12, loopMode: 'once' },
  { action: 'death',  frames: 6, fps: 8,  loopMode: 'once' },
  { action: 'jump',   frames: 3, fps: 10, loopMode: 'once' },
  { action: 'cast',   frames: 4, fps: 10, loopMode: 'once' },
];

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBaseUrl()}${path}`, {
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error ?? msg; } catch { /* keep status */ }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

const j = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });
const assetBase = (p: number, assetId: number) =>
  `/api/sprite-studio/projects/${p}/assets/${assetId}/animations`;
const animBase = (animId: number) => `/api/sprite-studio/animations/${animId}`;

export const listAnimations = (p: number, assetId: number): Promise<SpriteAnimation[]> =>
  req<{ animations: SpriteAnimation[] }>(assetBase(p, assetId)).then((r) => r.animations);

export const createAnimation = (
  p: number,
  assetId: number,
  input: { name: string; fps?: number; frames?: number },
): Promise<SpriteAnimation> => req<SpriteAnimation>(assetBase(p, assetId), j(input));

export const patchAnimation = (
  animId: number,
  patch: {
    fps?: number; loopMode?: AnimLoopMode; frameCount?: number;
    loopStart?: number | null; loopEnd?: number | null;
  },
): Promise<SpriteAnimation> =>
  req<SpriteAnimation>(animBase(animId), { method: 'PATCH', body: JSON.stringify(patch) });

export const deleteAnimation = (animId: number): Promise<void> =>
  req<{ ok: true }>(animBase(animId), { method: 'DELETE' }).then(() => undefined);

/**
 * Enqueue the frame-pack generation job; track it via useSpriteJobs' SSE map.
 * anchorVersionId picks WHICH version conditions the character identity
 * (must belong to the animation's asset); omitted = the asset's current.
 */
export const generateFrames = (
  animId: number,
  input: { intent?: string; direction?: string; anchorVersionId?: number; frameCount?: number } = {},
): Promise<{ jobId: number; n: number }> =>
  req<{ jobId: number; n: number }>(`${animBase(animId)}/frames/generate`, j(input));

/** Promote ALL staged candidates of a done job into versions + frame rows. */
export const adoptFrames = (animId: number, jobId: number): Promise<SpriteAnimation> =>
  req<SpriteAnimation>(`${animBase(animId)}/frames/adopt`, j({ jobId }));

export type AnchorX = 'left' | 'center' | 'right';
export type AnchorY = 'top' | 'middle' | 'bottom';

/**
 * Registration tool: auto-crop every frame and re-anchor the content on its
 * own canvas (new 'edited' versions; the asset's current pointer stays put).
 */
export const alignFrames = (
  animId: number,
  anchor: { anchorX: AnchorX; anchorY: AnchorY },
): Promise<SpriteAnimation> =>
  req<SpriteAnimation>(`${animBase(animId)}/frames/align`, j(anchor));

/** Replace ONE track's cells (auto-committed by the timeline, debounced).
 *  Track 0 = dense reorder (indices rewritten); overlays = sparse explicit. */
export const saveFrames = (
  animId: number,
  frames: Array<{ frameIndex: number; versionId: number; durationMs?: number | null }>,
  track = 0,
): Promise<SpriteAnimation> =>
  req<SpriteAnimation>(`${animBase(animId)}/frames`, {
    method: 'PATCH', body: JSON.stringify({ frames, track }),
  });

// ── Animation layers (tracks) ────────────────────────────────────────────
export const addTrack = (animId: number, name?: string): Promise<SpriteAnimation> =>
  req<SpriteAnimation>(`${animBase(animId)}/tracks`, j({ name }));

export const patchTrack = (
  animId: number,
  trackId: number,
  patch: { name?: string; visible?: boolean },
): Promise<SpriteAnimation> =>
  req<SpriteAnimation>(`${animBase(animId)}/tracks/${trackId}`, {
    method: 'PATCH', body: JSON.stringify(patch),
  });

export const deleteTrack = (animId: number, trackId: number): Promise<SpriteAnimation> =>
  req<SpriteAnimation>(`${animBase(animId)}/tracks/${trackId}`, { method: 'DELETE' });

/** GIF preview/export URL (served with content-disposition inline). */
export const gifUrl = (animId: number): string => `${apiBaseUrl()}${animBase(animId)}/gif`;
