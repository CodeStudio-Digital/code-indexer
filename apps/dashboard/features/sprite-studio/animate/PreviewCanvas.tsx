/**
 * Dedicated animation preview — its own <canvas> + rAF clock, deliberately
 * NOT the editor engine (playback needs no layers/undo/tools). Frames are
 * preloaded as <img> from versionFileUrl and drawn nearest-neighbor at an
 * integer scale over a CSS checkerboard. Onion skin draws the previous
 * frame red-tinted and the next green-tinted at 30% alpha under the current.
 * fps / loop-mode edits are committed by the parent (PATCH animation).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Crosshair, Layers, Pause, Play } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { versionFileUrl } from '../api.js';
import type { AnimFrame, AnimLoopMode } from './api-anim.js';
import { PreviewScrubber } from './PreviewScrubber.js';

const CHECKER: React.CSSProperties = {
  backgroundImage: 'repeating-conic-gradient(rgba(128,128,128,0.25) 0% 25%, transparent 0% 50%)',
  backgroundSize: '16px 16px',
};
const LOOP_MODES: AnimLoopMode[] = ['loop', 'once', 'pingpong'];

function drawTinted(ctx: CanvasRenderingContext2D, img: HTMLImageElement, tint: string,
  x: number, y: number, w: number, h: number): void {
  const off = document.createElement('canvas');
  off.width = img.naturalWidth; off.height = img.naturalHeight;
  const octx = off.getContext('2d')!;
  octx.drawImage(img, 0, 0);
  octx.globalCompositeOperation = 'source-atop';
  octx.fillStyle = tint;
  octx.globalAlpha = 0.6; // tint, don't silhouette — keep some pixel detail
  octx.fillRect(0, 0, off.width, off.height);
  ctx.drawImage(off, x, y, w, h);
}

export function PreviewCanvas({ projectId, frames, fps, loopMode, selectedIndex, loopStart, loopEnd, onPatch, onScrub, onSetLoop }: {
  projectId: number;
  frames: AnimFrame[];
  fps: number;
  loopMode: AnimLoopMode;
  /** Timeline selection; shown (and held) while paused. */
  selectedIndex: number;
  /** Loop in/out (frame indices); null = whole clip. Restricts playback. */
  loopStart: number | null;
  loopEnd: number | null;
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
  const [guides, setGuides] = useState(false);
  const [, bump] = useState(0); // re-draw trigger for image loads

  // Preload every frame image once; drop entries whose version disappeared.
  useEffect(() => {
    const map = imagesRef.current;
    const wanted = new Set(frames.map((f) => f.versionId));
    for (const key of map.keys()) if (!wanted.has(key)) map.delete(key);
    for (const f of frames) {
      if (map.has(f.versionId)) continue;
      const img = new Image();
      img.src = versionFileUrl(projectId, f.versionId);
      img.onload = () => bump((v) => v + 1);
      map.set(f.versionId, img);
    }
  }, [frames, projectId]);

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
    const n = frames.length;
    if (n === 0) return;
    const idx = Math.max(0, Math.min(n - 1, playheadRef.current));
    if (headRef.current && n > 1) headRef.current.style.left = `${(idx / (n - 1)) * 100}%`;
    const img = imagesRef.current.get(frames[idx].versionId);
    if (!img?.complete || img.naturalWidth === 0) return;
    let scale = Math.min(canvas.width / img.naturalWidth, canvas.height / img.naturalHeight);
    if (scale >= 1) scale = Math.floor(scale); // integer NN upscale
    const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
    const x = (canvas.width - w) / 2, y = (canvas.height - h) / 2;
    if (onion && n > 1) {
      ctx.globalAlpha = 0.3;
      const prev = imagesRef.current.get(frames[(idx - 1 + n) % n].versionId);
      const next = imagesRef.current.get(frames[(idx + 1) % n].versionId);
      if (prev?.complete) drawTinted(ctx, prev, '#ef4444', x, y, w, h);
      if (next?.complete) drawTinted(ctx, next, '#22c55e', x, y, w, h);
      ctx.globalAlpha = 1;
    }
    ctx.drawImage(img, x, y, w, h);
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
  }, [frames, onion, guides]);

  // rAF clock: advance the playhead by per-frame duration (override or 1000/fps).
  useEffect(() => {
    if (!playing || frames.length === 0) return;
    let raf = 0, last = performance.now(), acc = 0;
    const tick = (now: number) => {
      acc += now - last; last = now;
      const n = frames.length;
      // Playback stays inside the loop range [lo, hi] (defaults to whole clip).
      const lo = Math.max(0, Math.min(n - 1, loopStart ?? 0));
      const hi = Math.max(lo, Math.min(n - 1, loopEnd ?? n - 1));
      const dur = Math.max(20, frames[playheadRef.current]?.durationMs ?? 1000 / Math.max(1, fps));
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
  }, [playing, frames, fps, loopMode, loopStart, loopEnd, draw]);

  const handleScrub = useCallback((i: number) => {
    playheadRef.current = Math.max(0, Math.min(frames.length - 1, i));
    onScrub(i);
    draw();
  }, [frames.length, onScrub, draw]);

  // Paused → the playhead follows (and holds) the timeline selection.
  useEffect(() => {
    if (playing) return;
    playheadRef.current = Math.max(0, Math.min(frames.length - 1, selectedIndex));
    draw();
  }, [playing, selectedIndex, frames, draw, onion]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div ref={boxRef} className="relative min-h-0 flex-1 overflow-hidden rounded border" style={CHECKER}>
        <canvas ref={canvasRef} className="absolute inset-0" />
        {frames.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-xs text-muted-foreground">
            {t('animate.noFrames')}
          </div>
        )}
      </div>
      <PreviewScrubber
        n={frames.length}
        loopStart={loopStart}
        loopEnd={loopEnd}
        currentIndex={selectedIndex}
        headRef={headRef}
        onScrub={handleScrub}
        onSetLoop={onSetLoop}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" className="h-7 w-7 p-0" disabled={frames.length === 0}
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
          title={t('animate.preview.onion')} aria-pressed={onion} onClick={() => setOnion((v) => !v)}>
          <Layers className="h-3 w-3" /> {t('animate.preview.onion')}
        </Button>
        <Button size="sm" variant={guides ? 'secondary' : 'outline'} className="h-7 gap-1 px-2 text-[11px]"
          title={t('animate.guides')} aria-pressed={guides} onClick={() => setGuides((v) => !v)}>
          <Crosshair className="h-3 w-3" /> {t('animate.guides')}
        </Button>
        <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
          {frames.length > 0 &&
            t('animate.preview.frameOf', { i: Math.min(selectedIndex + 1, frames.length), n: frames.length })}
        </span>
      </div>
    </div>
  );
}
