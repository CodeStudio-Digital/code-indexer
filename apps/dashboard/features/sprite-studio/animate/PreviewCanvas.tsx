/**
 * Dedicated animation preview — its own <canvas> + rAF clock, deliberately
 * NOT the editor engine (playback needs no layers/undo/tools). Frames are
 * preloaded as <img> from versionFileUrl and drawn nearest-neighbor at an
 * integer scale over a CSS checkerboard. Onion skin draws the previous
 * frame red-tinted and the next green-tinted at 30% alpha under the current.
 * fps / loop-mode edits are committed by the parent (PATCH animation).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Crosshair, Layers, Move, Pause, Play } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { RangeInput } from '../../../components/ui/range-input.js';
import { versionFileUrl } from '../api.js';
import type { AnimFrame, AnimLoopMode, TrackMeta } from './api-anim.js';
import { buildTimelineModel } from './timeline-model.js';
import { PreviewScrubber } from './PreviewScrubber.js';

const CHECKER: React.CSSProperties = {
  backgroundImage: 'repeating-conic-gradient(rgba(128,128,128,0.25) 0% 25%, transparent 0% 50%)',
  backgroundSize: '16px 16px',
};
const LOOP_MODES: AnimLoopMode[] = ['loop', 'once', 'pingpong'];

/** Tinted-ghost cache keyed by the IMAGE ELEMENT — draw() runs per rAF tick
 *  during playback, and building a full-res canvas per ghost per tick was
 *  ~120-288 canvas allocations/second. Keying on the element makes staleness
 *  impossible: the preload effect swaps in a NEW Image whenever a version's
 *  contentHash changes, so the old entry (and its tints) just get GC'd. */
const tintCache = new WeakMap<HTMLImageElement, Map<string, HTMLCanvasElement>>();
const TINT_CACHE_LIMIT = 4;

const subjectCanvasCache = new WeakMap<HTMLImageElement, HTMLCanvasElement>();

interface BBox { minX: number; minY: number; maxX: number; maxY: number }
interface DragState { pointerId: number; startX: number; startY: number; startDx: number; startDy: number }
interface RenderMetrics { scale: number; frameWidth: number; frameHeight: number }
interface Offset { dx: number; dy: number }

function drawTinted(ctx: CanvasRenderingContext2D, img: HTMLImageElement, tint: string,
  x: number, y: number, w: number, h: number): void {
  let byTint = tintCache.get(img);
  if (!byTint) { byTint = new Map(); tintCache.set(img, byTint); }
  let off = byTint.get(tint);
  if (!off) {
    if (byTint.size >= TINT_CACHE_LIMIT) {
      const first = byTint.keys().next().value as string | undefined;
      if (first) byTint.delete(first);
    }
    off = document.createElement('canvas');
    off.width = img.naturalWidth; off.height = img.naturalHeight;
    const octx = off.getContext('2d')!;
    octx.drawImage(img, 0, 0);
    octx.globalCompositeOperation = 'source-atop';
    octx.fillStyle = tint;
    octx.globalAlpha = 0.6; // tint, don't silhouette — keep some pixel detail
    octx.fillRect(0, 0, off.width, off.height);
    byTint.set(tint, off);
  }
  ctx.drawImage(off, x, y, w, h);
}

function opaqueBBox(data: Uint8ClampedArray, width: number, height: number): BBox | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

function buildSubjectCanvas(img: HTMLImageElement): HTMLCanvasElement {
  const cached = subjectCanvasCache.get(img);
  if (cached) return cached;
  const off = document.createElement('canvas');
  off.width = img.naturalWidth;
  off.height = img.naturalHeight;
  const ctx = off.getContext('2d');
  if (!ctx) return off;
  ctx.drawImage(img, 0, 0);
  try {
    const image = ctx.getImageData(0, 0, off.width, off.height);
    clearLightBackdrop(image.data, off.width, off.height);
    ctx.putImageData(image, 0, 0);
  } catch {
    // If a browser security boundary ever taints this canvas, live drag still
    // works by shifting the raw image; the server save applies the subject-only
    // processing path.
  }
  subjectCanvasCache.set(img, off);
  return off;
}

function clearLightBackdrop(data: Uint8ClampedArray, width: number, height: number): void {
  const box = opaqueBBox(data, width, height);
  if (!box) return;
  const counts = new Map<number, number>();
  let total = 0;
  const tally = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    if (data[i + 3] === 0) return;
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
    total++;
  };
  for (let x = box.minX; x <= box.maxX; x++) {
    tally(x, box.minY);
    if (box.maxY !== box.minY) tally(x, box.maxY);
  }
  for (let y = box.minY + 1; y < box.maxY; y++) {
    tally(box.minX, y);
    if (box.maxX !== box.minX) tally(box.maxX, y);
  }
  let bestKey: number | null = null;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) { bestKey = key; bestCount = count; }
  }
  if (bestKey == null || total === 0 || bestCount / total < 0.55) return;
  const key = { r: (bestKey >> 16) & 0xff, g: (bestKey >> 8) & 0xff, b: bestKey & 0xff };
  const max = Math.max(key.r, key.g, key.b);
  const min = Math.min(key.r, key.g, key.b);
  if (max < 160 || max - min > 40) return;
  const tolSq = 48 * 48;
  const visited = new Uint8Array(width * height);
  const stack: number[] = [];
  const close = (idx: number): boolean => {
    if (visited[idx]) return false;
    const i = idx * 4;
    if (data[i + 3] === 0) return false;
    const dr = data[i] - key.r;
    const dg = data[i + 1] - key.g;
    const db = data[i + 2] - key.b;
    return dr * dr + dg * dg + db * db <= tolSq;
  };
  const push = (x: number, y: number) => {
    const idx = y * width + x;
    if (close(idx)) stack.push(idx);
  };
  for (let x = box.minX; x <= box.maxX; x++) { push(x, box.minY); push(x, box.maxY); }
  for (let y = box.minY + 1; y < box.maxY; y++) { push(box.minX, y); push(box.maxX, y); }
  while (stack.length > 0) {
    const idx = stack.pop()!;
    if (!close(idx)) continue;
    visited[idx] = 1;
    data[idx * 4 + 3] = 0;
    const x = idx % width;
    const y = Math.floor(idx / width);
    if (x > box.minX) push(x - 1, y);
    if (x < box.maxX) push(x + 1, y);
    if (y > box.minY) push(x, y - 1);
    if (y < box.maxY) push(x, y + 1);
  }
}

export function PreviewCanvas({
  projectId, frames, tracks, fps, loopMode, selectedIndex, loopStart, loopEnd,
  versionById, repositioning = false, onPatch, onScrub, onSetLoop, onRepositionFrame,
}: {
  projectId: number;
  /** FLAT frame list (every track); columns composite bottom-up. */
  frames: AnimFrame[];
  tracks: TrackMeta[];
  fps: number;
  loopMode: AnimLoopMode;
  /** Timeline selection; shown (and held) while paused. */
  selectedIndex: number;
  /** Loop in/out (frame indices); null = whole clip. Restricts playback. */
  loopStart: number | null;
  loopEnd: number | null;
  /** Version rows — contentHash busts the preload cache after in-place edits. */
  versionById?: Map<string, import('../types.js').AssetVersion>;
  /** True while the backend is baking a manually repositioned frame. */
  repositioning?: boolean;
  onPatch: (patch: { fps?: number; loopMode?: AnimLoopMode }) => void;
  /** Move the timeline selection (scrubber drag). */
  onScrub: (i: number) => void;
  /** Persist the loop in/out range (frame indices, or null to clear). */
  onSetLoop: (start: number | null, end: number | null) => void;
  /** Bake a manual subject offset for the selected base frame. */
  onRepositionFrame?: (dx: number, dy: number) => void | Promise<void>;
}) {
  const { t } = useTranslation('spriteStudio');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const imagesRef = useRef(new Map<string, HTMLImageElement>());
  const playheadRef = useRef(0);
  const dirRef = useRef(1); // pingpong bounce direction
  const dragRef = useRef<DragState | null>(null);
  const metricsRef = useRef<RenderMetrics | null>(null);
  const [playing, setPlaying] = useState(false);
  const [onion, setOnion] = useState(false);
  const [onionAlpha, setOnionAlpha] = useState(35); // % — sprites often have OPAQUE bgs
  const [guides, setGuides] = useState(false);
  const [repositionMode, setRepositionMode] = useState(false);
  const [draftOffset, setDraftOffset] = useState<Offset>({ dx: 0, dy: 0 });
  const draftOffsetRef = useRef<Offset>(draftOffset);
  // Image loads redraw through this ref (kept current below) — the old dummy
  // state bump re-rendered the component but never actually called draw().
  const drawRef = useRef<() => void>(() => {});

  // Column-addressable grid over every track (visibleStack = composite order).
  const model = useMemo(() => buildTimelineModel(frames, tracks, fps), [frames, tracks, fps]);
  const selectedBaseFrame = useMemo(() => {
    if (model.gridLen === 0) return null;
    const i = Math.max(0, Math.min(model.gridLen - 1, selectedIndex));
    return model.cellAt(0, i);
  }, [model, selectedIndex]);
  const selectedVersion = selectedBaseFrame ? versionById?.get(selectedBaseFrame.versionId) : undefined;
  const frameSizeLabel = selectedVersion?.width && selectedVersion.height
    ? `${selectedVersion.width}×${selectedVersion.height}`
    : null;
  const canReposition = !!onRepositionFrame && !!selectedBaseFrame && model.gridLen > 0;
  const hasDraftOffset = draftOffset.dx !== 0 || draftOffset.dy !== 0;

  const setDraft = useCallback((next: Offset) => {
    draftOffsetRef.current = next;
    setDraftOffset(next);
    drawRef.current();
  }, []);

  // Preload every frame image; drop entries whose version disappeared and
  // RELOAD entries whose contentHash changed (in-place "Salvar Sprite" edits
  // keep the versionId but swap the bytes).
  const hashesRef = useRef(new Map<string, string | null>());
  const loadGenRef = useRef(0);
  useEffect(() => {
    const gen = loadGenRef.current + 1;
    loadGenRef.current = gen;
    const map = imagesRef.current;
    const hashes = hashesRef.current;
    const wanted = new Set(frames.map((f) => f.versionId));
    for (const key of map.keys()) {
      if (!wanted.has(key)) {
        const old = map.get(key);
        if (old) old.onload = null;
        map.delete(key);
        hashes.delete(key);
      }
    }
    for (const f of frames) {
      const hash = versionById?.get(f.versionId)?.contentHash ?? null;
      const current = map.get(f.versionId);
      if (current && hashes.get(f.versionId) === hash) {
        current.onload = () => {
          if (loadGenRef.current !== gen) return;
          if (imagesRef.current.get(f.versionId) !== current) return;
          drawRef.current();
        };
        continue;
      }
      if (current) current.onload = null;
      const img = new Image();
      img.onload = () => {
        if (loadGenRef.current !== gen) return;
        if (imagesRef.current.get(f.versionId) !== img) return;
        drawRef.current();
      };
      img.src = versionFileUrl(projectId, f.versionId, hash);
      map.set(f.versionId, img);
      hashes.set(f.versionId, hash);
    }
    return () => {
      if (loadGenRef.current === gen) loadGenRef.current += 1;
    };
  }, [frames, projectId, versionById]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const box = boxRef.current;
    if (!canvas || !box) return;
    const n = model.gridLen;
    if (n === 0) {
      metricsRef.current = null;
      if (canvas.width !== 1 || canvas.height !== 1) { canvas.width = 1; canvas.height = 1; }
      canvas.style.width = '0px';
      canvas.style.height = '0px';
      return;
    }
    const idx = Math.max(0, Math.min(n - 1, playheadRef.current));
    if (headRef.current && n > 1) headRef.current.style.left = `${(idx / (n - 1)) * 100}%`;
    // Composite the column's visible layers bottom-up at the SAME rect.
    const stack = model.visibleStack(idx)
      .map((f) => ({ frame: f, img: imagesRef.current.get(f.versionId) }))
      .filter((item): item is { frame: AnimFrame; img: HTMLImageElement } =>
        !!item.img?.complete && item.img.naturalWidth > 0);
    const ref = stack[0]?.img;
    if (!ref) {
      metricsRef.current = null;
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      return; // whole column empty (blank hold) or images still loading
    }

    let scale = Math.min(
      Math.max(1, box.clientWidth - 16) / ref.naturalWidth,
      Math.max(1, box.clientHeight - 16) / ref.naturalHeight,
    );
    if (scale >= 1) scale = Math.max(1, Math.floor(scale)); // integer NN upscale
    const w = Math.max(1, Math.round(ref.naturalWidth * scale));
    const h = Math.max(1, Math.round(ref.naturalHeight * scale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    canvas.style.left = `${Math.max(0, Math.round((box.clientWidth - w) / 2))}px`;
    canvas.style.top = `${Math.max(0, Math.round((box.clientHeight - h) / 2))}px`;
    metricsRef.current = { scale, frameWidth: ref.naturalWidth, frameHeight: ref.naturalHeight };

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const offset = draftOffsetRef.current;
    const previewOffset = repositionMode && !playing && (offset.dx !== 0 || offset.dy !== 0);
    for (const { frame, img } of stack) {
      const moved = previewOffset && frame.track === 0 && frame.frameIndex === idx;
      const source = moved ? buildSubjectCanvas(img) : img;
      ctx.drawImage(source, moved ? offset.dx * scale : 0, moved ? offset.dy * scale : 0, w, h);
    }
    // Onion ghosts go ON TOP of the current frame: generated sprites carry an
    // OPAQUE background, so ghosts drawn underneath were 100% covered (the
    // "onion skin does nothing" bug). Base track only; alpha user-tunable.
    if (onion && n > 1) {
      ctx.globalAlpha = Math.max(0.1, Math.min(0.7, onionAlpha / 100));
      const prevF = model.cellAt(0, (idx - 1 + n) % n);
      const nextF = model.cellAt(0, (idx + 1) % n);
      const prev = prevF ? imagesRef.current.get(prevF.versionId) : undefined;
      const next = nextF ? imagesRef.current.get(nextF.versionId) : undefined;
      if (prev?.complete) drawTinted(ctx, prev, '#ef4444', 0, 0, w, h);
      if (next?.complete) drawTinted(ctx, next, '#22c55e', 0, 0, w, h);
      ctx.globalAlpha = 1;
    }
    if (guides) {
      // Registration guides: midlines of the DRAWN frame rect at 25% alpha.
      ctx.globalAlpha = 0.25;
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(w / 2) + 0.5, 0);
      ctx.lineTo(Math.round(w / 2) + 0.5, h);
      ctx.moveTo(0, Math.round(h / 2) + 0.5);
      ctx.lineTo(w, Math.round(h / 2) + 0.5);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }, [model, onion, onionAlpha, guides, repositionMode, playing]);
  useEffect(() => { drawRef.current = draw; draw(); }, [draw]);

  // rAF clock: advance the playhead by column duration (track-0 master line).
  useEffect(() => {
    if (!playing || model.gridLen === 0) return;
    let raf = 0, last = performance.now(), acc = 0;
    const tick = (now: number) => {
      acc += now - last; last = now;
      const n = model.gridLen;
      // Playback stays inside the loop range [lo, hi] (defaults to whole clip).
      const lo = Math.max(0, Math.min(n - 1, loopStart ?? 0));
      const hi = Math.max(lo, Math.min(n - 1, loopEnd ?? n - 1));
      const dur = Math.max(20, model.columnDuration(playheadRef.current));
      while (acc >= dur) {
        acc -= dur;
        if (playheadRef.current < lo || playheadRef.current > hi) playheadRef.current = lo;
        if (loopMode === 'pingpong' && hi > lo) {
          let next = playheadRef.current + dirRef.current;
          if (next < lo || next > hi) { dirRef.current *= -1; next = playheadRef.current + dirRef.current; }
          playheadRef.current = next;
        } else if (playheadRef.current + 1 > hi) {
          if (loopMode === 'once') { setPlaying(false); break; }
          playheadRef.current = lo;
        } else {
          playheadRef.current += 1;
        }
      }
      draw();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, model, fps, loopMode, loopStart, loopEnd, draw]);

  const handleScrub = useCallback((i: number) => {
    playheadRef.current = Math.max(0, Math.min(model.gridLen - 1, i));
    onScrub(i);
    draw();
  }, [model.gridLen, onScrub, draw]);

  // Paused → the playhead follows (and holds) the timeline selection.
  useEffect(() => {
    if (playing) return;
    playheadRef.current = Math.max(0, Math.min(model.gridLen - 1, selectedIndex));
    draw();
  }, [playing, selectedIndex, model, draw, onion]);

  useEffect(() => {
    dragRef.current = null;
    setDraft({ dx: 0, dy: 0 });
  }, [selectedIndex, frames, setDraft]);

  useEffect(() => {
    if (!playing) return;
    setRepositionMode(false);
    setDraft({ dx: 0, dy: 0 });
  }, [playing, setDraft]);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!repositionMode || !canReposition || playing || repositioning) return;
    const metrics = metricsRef.current;
    if (!metrics) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startDx: draftOffsetRef.current.dx,
      startDy: draftOffsetRef.current.dy,
    };
  }, [repositionMode, canReposition, playing, repositioning]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    const metrics = metricsRef.current;
    if (!drag || !metrics || drag.pointerId !== e.pointerId) return;
    if ((e.buttons & 1) === 0) { dragRef.current = null; return; }
    const next = {
      dx: drag.startDx + Math.round((e.clientX - drag.startX) / metrics.scale),
      dy: drag.startDy + Math.round((e.clientY - drag.startY) / metrics.scale),
    };
    if (next.dx !== draftOffsetRef.current.dx || next.dy !== draftOffsetRef.current.dy) setDraft(next);
  }, [setDraft]);

  const endDrag = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current?.pointerId !== e.pointerId) return;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  const handleSaveReposition = useCallback(async () => {
    if (!onRepositionFrame) return;
    const { dx, dy } = draftOffsetRef.current;
    if (dx === 0 && dy === 0) return;
    try {
      await onRepositionFrame(dx, dy);
      setDraft({ dx: 0, dy: 0 });
      setRepositionMode(false);
    } catch {
      // Parent already surfaced the error; keep the local offset so the user can retry.
    }
  }, [onRepositionFrame, setDraft]);

  const toggleReposition = useCallback(() => {
    setPlaying(false);
    setRepositionMode((v) => {
      if (v) setDraft({ dx: 0, dy: 0 });
      return !v;
    });
  }, [setDraft]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div ref={boxRef} className="relative min-h-0 flex-1 overflow-hidden rounded border bg-muted/20">
        <canvas
          ref={canvasRef}
          className={`absolute rounded-sm border border-border/70 shadow-lg ${repositionMode ? 'cursor-grab active:cursor-grabbing' : ''}`}
          style={CHECKER}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />
        {repositionMode && canReposition && (
          <div className="pointer-events-none absolute left-2 top-2 rounded bg-background/85 px-2 py-1 text-[10px] text-muted-foreground shadow">
            {t('animate.reposition.hint')}
          </div>
        )}
        {model.gridLen === 0 && (
          <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-xs text-muted-foreground">
            {t('animate.noFrames')}
          </div>
        )}
      </div>
      <PreviewScrubber
        n={model.gridLen}
        loopStart={loopStart}
        loopEnd={loopEnd}
        currentIndex={selectedIndex}
        headRef={headRef}
        onScrub={handleScrub}
        onSetLoop={onSetLoop}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" className="h-7 w-7 p-0" disabled={model.gridLen === 0}
          title={playing ? t('animate.preview.pause') : t('animate.preview.play')}
          onClick={() => setPlaying((p) => !p)}>
          {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </Button>
        <select className="h-7 rounded border bg-background px-2 text-xs" value={loopMode}
          aria-label={t('animate.preview.loopMode')}
          onChange={(e) => onPatch({ loopMode: e.target.value as AnimLoopMode })}>
          {LOOP_MODES.map((m) => <option key={m} value={m}>{t(`animate.preview.${m}`)}</option>)}
        </select>
        <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
          {t('animate.fps')}
          <Input type="number" min={1} max={60} className="h-7 w-14 text-xs" value={fps}
            onChange={(e) => onPatch({ fps: Math.max(1, Math.min(60, Number(e.target.value) || 1)) })} />
        </label>
        <Button size="sm" variant={onion ? 'secondary' : 'outline'} className="h-7 gap-1 px-2 text-[11px]"
          title={t('animate.preview.onionHint')} aria-pressed={onion} onClick={() => setOnion((v) => !v)}>
          <Layers className="h-3 w-3" /> {t('animate.preview.onion')}
        </Button>
        {onion && (
          <RangeInput
            min={10} max={70} step={5} value={onionAlpha} onChange={setOnionAlpha}
            suffix="%" sliderClassName="w-16" className="text-[10px] text-muted-foreground"
            aria-label={t('animate.preview.onionAlpha')}
          />
        )}
        <Button size="sm" variant={guides ? 'secondary' : 'outline'} className="h-7 gap-1 px-2 text-[11px]"
          title={t('animate.guides')} aria-pressed={guides} onClick={() => setGuides((v) => !v)}>
          <Crosshair className="h-3 w-3" /> {t('animate.guides')}
        </Button>
        <Button size="sm" variant={repositionMode ? 'secondary' : 'outline'} className="h-7 gap-1 px-2 text-[11px]"
          disabled={!canReposition || repositioning}
          title={canReposition ? t('animate.reposition.hint') : t('animate.reposition.noCurrentFrame')}
          aria-pressed={repositionMode}
          onClick={toggleReposition}>
          <Move className="h-3 w-3" /> {t('animate.reposition.button')}
        </Button>
        {repositionMode && (
          <>
            <span className="text-[10px] tabular-nums text-muted-foreground">
              {t('animate.reposition.offset', { x: draftOffset.dx, y: draftOffset.dy })}
            </span>
            <Button size="sm" variant="default" className="h-7 px-2 text-[11px]"
              disabled={!hasDraftOffset || repositioning}
              onClick={() => void handleSaveReposition()}>
              {repositioning ? t('animate.reposition.saving') : t('animate.reposition.save')}
            </Button>
            <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" disabled={repositioning}
              onClick={() => { setDraft({ dx: 0, dy: 0 }); setRepositionMode(false); }}>
              {t('animate.reposition.cancel')}
            </Button>
          </>
        )}
        {frameSizeLabel && <span className="text-[10px] text-muted-foreground">{frameSizeLabel}</span>}
        <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
          {model.gridLen > 0 &&
            t('animate.preview.frameOf', { i: Math.min(selectedIndex + 1, model.gridLen), n: model.gridLen })}
        </span>
      </div>
    </div>
  );
}
