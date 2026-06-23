/**
 * WhatsApp-style recording overlay shown while dictating: a big, voice-reactive
 * `<LogoMark>` on the LEFT, then a waveform TIMELINE that draws the amplitude
 * history as you speak (newest bars on the right, scrolling left as it fills),
 * an mm:ss timer, and a Stop button. Rendered by the composer as an
 * `absolute inset-0` overlay over its input while `status === 'recording'`.
 *
 * Perf: ONE requestAnimationFrame reads the shared `AnalyserNode` (time-domain
 * RMS), appends a bar every ~70ms, repaints the canvas, and writes the live
 * level onto the logo wrapper via ref (CSS `--mic-level` + a reactive glow) —
 * no React state per frame. Honors `prefers-reduced-motion` (static, no rAF).
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Square } from 'lucide-react';
import { getVoiceCapture } from './voice-capture-store.js';
import { LogoMark } from './LogoMark.js';

interface VoiceCaptureBarProps {
  onStop: () => void;
}

const BAR_W = 3; // px (css) per bar
const BAR_GAP = 2;
const BAR_MS = 70; // commit one amplitude sample every ~70ms (timeline cadence)
const GRADIENT_STOPS: Array<[number, string]> = [
  [0, '#67e8f9'],
  [0.5, '#22d3ee'],
  [0.8, '#6366f1'],
  [1, '#a855f7'],
];

function fmt(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function VoiceCaptureBar({ onStop }: VoiceCaptureBarProps) {
  const { t } = useTranslation('chat');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const logoWrapRef = useRef<HTMLDivElement>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const reduced =
      typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const startedAt = performance.now();
    const td = new Uint8Array(2048);
    const history: number[] = []; // amplitude per time-slice (0..1), oldest → newest
    let raf = 0;
    let lastPush = startedAt;
    let peak = 0; // loudest amplitude since the last committed bar
    let smooth = 0; // smoothed level for the logo

    const timer = setInterval(() => setElapsed(Math.floor((performance.now() - startedAt) / 1000)), 500);

    const setLogo = (lvl: number) => {
      const el = logoWrapRef.current;
      if (!el) return;
      el.style.setProperty('--mic-level', String(lvl));
      el.style.filter = `drop-shadow(0 0 ${(4 + lvl * 18).toFixed(1)}px rgba(103,232,249,0.55))`;
    };

    const draw = () => {
      const canvas = canvasRef.current;
      const analyser = getVoiceCapture().analyser;
      if (canvas && analyser) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
          canvas.width = Math.round(w * dpr);
          canvas.height = Math.round(h * dpr);
        }
        const ctx = canvas.getContext('2d');
        if (ctx) {
          // Current amplitude: time-domain RMS (truest "loudness").
          const n = analyser.fftSize;
          analyser.getByteTimeDomainData(td.subarray(0, n));
          let sumSq = 0;
          for (let i = 0; i < n; i++) {
            const v = (td[i] - 128) / 128;
            sumSq += v * v;
          }
          const amp = Math.min(1, Math.sqrt(sumSq / n) * 3.4);
          peak = Math.max(peak, amp);
          smooth = smooth * 0.78 + amp * 0.22;
          setLogo(Math.min(1, smooth * 1.6));

          // Commit a bar every BAR_MS — this is what builds the timeline.
          const now = performance.now();
          if (now - lastPush >= BAR_MS) {
            history.push(peak);
            peak = 0;
            lastPush = now;
          }
          const unit = BAR_W + BAR_GAP;
          const maxBars = Math.max(1, Math.floor(w / unit));
          if (history.length > maxBars) history.splice(0, history.length - maxBars);

          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.clearRect(0, 0, w, h);
          const grad = ctx.createLinearGradient(0, 0, w, 0);
          for (const [o, c] of GRADIENT_STOPS) grad.addColorStop(o, c);
          ctx.fillStyle = grad;

          const live = history.length;
          for (let i = 0; i < live; i++) {
            const a = history[i];
            const barH = Math.max(2, a * h * 0.92);
            const x = w - (live - i) * unit; // newest hugs the right edge
            const y = (h - barH) / 2;
            ctx.globalAlpha = 0.35 + 0.65 * (i / Math.max(1, live - 1)); // older = dimmer trail
            ctx.beginPath();
            ctx.roundRect(x, y, BAR_W, barH, BAR_W / 2);
            ctx.fill();
          }
          ctx.globalAlpha = 1;
        }
      }
      raf = requestAnimationFrame(draw);
    };

    if (reduced) {
      setLogo(0.3);
    } else {
      raf = requestAnimationFrame(draw);
    }
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="absolute inset-0 z-10 flex items-center gap-3 rounded-[inherit] border border-rose-500/30 bg-background/90 px-3 backdrop-blur-sm">
      <div ref={logoWrapRef} className="shrink-0" style={{ willChange: 'filter, transform' }}>
        <LogoMark className="h-12 w-12" />
      </div>
      <canvas ref={canvasRef} className="h-9 flex-1" />
      <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums text-muted-foreground">
        <span className="h-2 w-2 animate-pulse rounded-full bg-rose-500" />
        {fmt(elapsed)}
      </span>
      <button
        type="button"
        onClick={onStop}
        aria-label={t('composer.mic.stop', { defaultValue: 'Parar gravação' })}
        title={t('composer.mic.stop', { defaultValue: 'Parar gravação' })}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-rose-500/15 text-rose-500 transition-colors hover:bg-rose-500/25"
      >
        <Square className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
