/**
 * Animation API — fetch wrappers over the animation routes
 * (apps/http-api/server/routes/sprite-studio/animations.routes.ts). Lives
 * beside AnimatePanel instead of api.ts so the animation slice never
 * contends on that file. Same direct-fetch pattern against `apiBaseUrl()`.
 */
import { apiBaseUrl } from '../../../lib/api-client.js';

export type AnimLoopMode = 'loop' | 'once' | 'pingpong';

export interface AnimFrame {
  id: string;
  frameIndex: number;
  versionId: string;
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
  id: string;
  assetId: string;
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
  anchorVersionId: string | null;
  /** Job whose candidates were last adopted as frames; null = never. */
  lastGenJobId: string | null;
  /** Playback loop range (frame indices); null = whole clip. */
  loopStart: number | null;
  loopEnd: number | null;
  actionKey: string;
  direction: string | null;
  exportName: string;
  pivot: { x: number; y: number };
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

export const listActionPresets = (): Promise<{ actions: ActionPreset[]; directions: string[] }> =>
  req<{ actions: ActionPreset[]; directions: string[] }>('/api/sprite-studio/animation-actions');

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
const assetBase = (p: number, assetId: string) =>
  `/api/sprite-studio/projects/${p}/assets/${assetId}/animations`;
const animBase = (animId: string) => `/api/sprite-studio/animations/${animId}`;

export const listAnimations = (p: number, assetId: string): Promise<SpriteAnimation[]> =>
  req<{ animations: SpriteAnimation[] }>(assetBase(p, assetId)).then((r) => r.animations);

export const createAnimation = (
  p: number,
  assetId: string,
  input: {
    name: string; fps?: number; frames?: number; loopMode?: AnimLoopMode;
    actionKey?: string; direction?: string; exportName?: string;
  },
): Promise<SpriteAnimation> => req<SpriteAnimation>(assetBase(p, assetId), j(input));

export const patchAnimation = (
  animId: string,
  patch: {
    fps?: number; loopMode?: AnimLoopMode; frameCount?: number;
    loopStart?: number | null; loopEnd?: number | null;
    actionKey?: string; direction?: string | null; exportName?: string; pivot?: { x: number; y: number };
  },
): Promise<SpriteAnimation> =>
  req<SpriteAnimation>(animBase(animId), { method: 'PATCH', body: JSON.stringify(patch) });

export const deleteAnimation = (animId: string): Promise<void> =>
  req<{ ok: true }>(animBase(animId), { method: 'DELETE' }).then(() => undefined);

/**
 * Enqueue the frame-pack generation job; track it via useSpriteJobs' SSE map.
 * anchorVersionId picks WHICH version conditions the character identity
 * (must belong to the animation's asset); omitted = the asset's current.
 */
export const generateFrames = (
  animId: string,
  input: { intent?: string; direction?: string; anchorVersionId?: string; frameCount?: number } = {},
): Promise<{ jobId: string; n: number }> =>
  req<{ jobId: string; n: number }>(`${animBase(animId)}/frames/generate`, j(input));

/** Promote ALL staged candidates of a done job into versions + frame rows. */
export const adoptFrames = (animId: string, jobId: string): Promise<SpriteAnimation> =>
  req<SpriteAnimation>(`${animBase(animId)}/frames/adopt`, j({ jobId }));

export type AnchorX = 'left' | 'center' | 'right';
export type AnchorY = 'top' | 'middle' | 'bottom';
export type AlignScope = 'all' | 'current';

/**
 * Registration tool: auto-crop targeted base-track frames and re-anchor the
 * content on each frame's own canvas (new 'edited' versions; the asset's
 * current pointer stays put). Omitting frameIndexes aligns every base frame.
 */
export const alignFrames = (
  animId: string,
  input: { anchorX: AnchorX; anchorY: AnchorY; frameIndexes?: number[] },
): Promise<SpriteAnimation> =>
  req<SpriteAnimation>(`${animBase(animId)}/frames/align`, j(input));

/** Manual registration: move one frame's subject inside its existing canvas and
 * bake the result as a new version, then repoint that timeline cell. */
export const repositionFrame = (
  animId: string,
  input: { frameIndex: number; dx: number; dy: number; track?: number },
): Promise<SpriteAnimation> =>
  req<SpriteAnimation>(`${animBase(animId)}/frames/reposition`, j(input));

/** Replace ONE track's cells (auto-committed by the timeline, debounced).
 *  Track 0 = dense reorder (indices rewritten); overlays = sparse explicit. */
export const saveFrames = (
  animId: string,
  frames: Array<{ frameIndex: number; versionId: string; durationMs?: number | null }>,
  track = 0,
): Promise<SpriteAnimation> =>
  req<SpriteAnimation>(`${animBase(animId)}/frames`, {
    method: 'PATCH', body: JSON.stringify({ frames, track }),
  });

/** Save a frame edit as a child version and repoint only this timeline cell. */
export const saveFrameVersion = async (
  animId: string,
  track: number,
  frameIndex: number,
  expectedVersionId: string,
  blob: Blob,
): Promise<{ animation: SpriteAnimation; versionId: string }> => {
  const form = new FormData();
  form.append('file', blob, 'edited-frame.png');
  form.append('expectedVersionId', String(expectedVersionId));
  const res = await fetch(`${apiBaseUrl()}${animBase(animId)}/frames/${track}/${frameIndex}/version`, {
    method: 'POST', body: form,
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try { message = (await res.json()).error ?? message; } catch { /* keep status */ }
    throw new Error(message);
  }
  return (await res.json()) as { animation: SpriteAnimation; versionId: string };
};

// ── Animation layers (tracks) ────────────────────────────────────────────
export const addTrack = (animId: string, name?: string): Promise<SpriteAnimation> =>
  req<SpriteAnimation>(`${animBase(animId)}/tracks`, j({ name }));

export const patchTrack = (
  animId: string,
  trackId: number,
  patch: { name?: string; visible?: boolean },
): Promise<SpriteAnimation> =>
  req<SpriteAnimation>(`${animBase(animId)}/tracks/${trackId}`, {
    method: 'PATCH', body: JSON.stringify(patch),
  });

export const deleteTrack = (animId: string, trackId: number): Promise<SpriteAnimation> =>
  req<SpriteAnimation>(`${animBase(animId)}/tracks/${trackId}`, { method: 'DELETE' });

/** GIF preview/export URL (served with content-disposition inline). */
export const gifUrl = (animId: string): string => `${apiBaseUrl()}${animBase(animId)}/gif`;
