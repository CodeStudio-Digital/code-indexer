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
import { Crosshair, Layers, Pause, Play } from 'lucide-react';
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

export function PreviewCanvas({ projectId, frames, tracks, fps, loopMode, selectedIndex, loopStart, loopEnd, versionById, onPatch, onScrub, onSetLoop }: {
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
  versionById?: Map<number, import('../types.js').AssetVersion>;
  onPatch: (patch: { fps?: number; loopMode?: AnimLoopMode }) => void;
  /** Move the timeline selection (scrubber drag). */
  onScrub: (i: number) => void;
  /** Persist the loop in/out range (frame indices, or null to clear). */
  onSetLoop: (start: number | null, end: number | null) => void;
}) {
  const { t } = useTranslation('spriteStudio');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const imagesRef = useRef(new Map<number, HTMLImageElement>());
  const playheadRef = useRef(0);
  const dirRef = useRef(1); // pingpong bounce direction
  const [playing, setPlaying] = useState(false);
  const [onion, setOnion] = useState(false);
  const [onionAlpha, setOnionAlpha] = useState(35); // % — sprites often have OPAQUE bgs
  const [guides, setGuides] = useState(false);
  // Image loads redraw through this ref (kept current below) — the old dummy
  // state bump re-rendered the component but never actually called draw().
  const drawRef = useRef<() => void>(() => {});

  // Column-addressable grid over every track (visibleStack = composite order).
  const model = useMemo(() => buildTimelineModel(frames, tracks, fps), [frames, tracks, fps]);

  // Preload every frame image; drop entries whose version disappeared and
  // RELOAD entries whose contentHash changed (in-place "Salvar Sprite" edits
  // keep the versionId but swap the bytes).
  const hashesRef = useRef(new Map<number, string | null>());
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
    if (canvas.width !== box.clientWidth || canvas.height !== box.clientHeight) {
      canvas.width = box.clientWidth; canvas.height = box.clientHeight;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const n = model.gridLen;
    if (n === 0) return;
    const idx = Math.max(0, Math.min(n - 1, playheadRef.current));
    if (headRef.current && n > 1) headRef.current.style.left = `${(idx / (n - 1)) * 100}%`;
    // Composite the column's visible layers bottom-up at the SAME rect.
    const stack = model.visibleStack(idx)
      .map((f) => imagesRef.current.get(f.versionId))
      .filter((im): im is HTMLImageElement => !!im?.complete && im.naturalWidth > 0);
    const ref = stack[0];
    if (!ref) return; // whole column empty (blank hold) or images still loading
    let scale = Math.min(canvas.width / ref.naturalWidth, canvas.height / ref.naturalHeight);
    if (scale >= 1) scale = Math.floor(scale); // integer NN upscale
    const w = ref.naturalWidth * scale, h = ref.naturalHeight * scale;
    const x = (canvas.width - w) / 2, y = (canvas.height - h) / 2;
    for (const im of stack) ctx.drawImage(im, x, y, w, h);
    // Onion ghosts go ON TOP of the current frame: generated sprites carry an
    // OPAQUE background, so ghosts drawn underneath were 100% covered (the
    // "onion skin does nothing" bug). Base track only; alpha user-tunable.
    if (onion && n > 1) {
      ctx.globalAlpha = Math.max(0.1, Math.min(0.7, onionAlpha / 100));
      const prevF = model.cellAt(0, (idx - 1 + n) % n);
      const nextF = model.cellAt(0, (idx + 1) % n);
      const prev = prevF ? imagesRef.current.get(prevF.versionId) : undefined;
      const next = nextF ? imagesRef.current.get(nextF.versionId) : undefined;
      if (prev?.complete) drawTinted(ctx, prev, '#ef4444', x, y, w, h);
      if (next?.complete) drawTinted(ctx, next, '#22c55e', x, y, w, h);
      ctx.globalAlpha = 1;
    }
    if (guides) {
      // Registration guides: midlines of the DRAWN frame rect at 25% alpha.
      ctx.globalAlpha = 0.25;
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x + w / 2) + 0.5, y);
      ctx.lineTo(Math.round(x + w / 2) + 0.5, y + h);
      ctx.moveTo(x, Math.round(y + h / 2) + 0.5);
      ctx.lineTo(x + w, Math.round(y + h / 2) + 0.5);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }, [model, onion, onionAlpha, guides]);
  useEffect(() => { drawRef.current = draw; }, [draw]);

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

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div ref={boxRef} className="relative min-h-0 flex-1 overflow-hidden rounded border" style={CHECKER}>
        <canvas ref={canvasRef} className="absolute inset-0" />
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
        <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
          {model.gridLen > 0 &&
            t('animate.preview.frameOf', { i: Math.min(selectedIndex + 1, model.gridLen), n: model.gridLen })}
        </span>
      </div>
    </div>
  );
}
