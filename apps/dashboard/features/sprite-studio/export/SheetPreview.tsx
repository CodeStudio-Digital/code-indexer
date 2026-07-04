/**
 * SheetPreview — a preview-only, client-side layout of the assets being
 * exported. Loads each asset's current thumbnail and draws a naive row-major
 * grid onto a <canvas>, honouring the padding/scale options (debounced on
 * change). This is illustrative only — the backend re-packs full-res; no
 * packing lib is needed here.
 */
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { SpriteAsset } from '../types.js';

const CELL = 48; // base preview cell size in px before scale

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

export function SheetPreview({
  assets,
  padding,
  scale,
}: {
  assets: SpriteAsset[];
  padding: number;
  scale: number;
}) {
  const { t } = useTranslation('spriteStudio');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const thumbs = assets.map((a) => a.thumbUrl).filter((u): u is string => !!u);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handle = setTimeout(() => void draw(), 150); // debounce option changes

    async function draw() {
      const el = canvasRef.current;
      if (!el) return;
      const cell = Math.max(8, CELL * scale);
      const pad = Math.max(0, padding);
      const step = cell + pad;
      const cols = Math.max(1, Math.min(thumbs.length, Math.floor(320 / step) || 1));
      const rows = Math.max(1, Math.ceil(thumbs.length / cols));
      el.width = cols * step + pad;
      el.height = rows * step + pad;

      const ctx = el.getContext('2d');
      if (!ctx) return;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, el.width, el.height);
      // Checkerboard backdrop.
      const s = 8;
      for (let y = 0; y < el.height; y += s) {
        for (let x = 0; x < el.width; x += s) {
          ctx.fillStyle = ((x / s + y / s) % 2 === 0) ? 'rgba(128,128,128,0.12)' : 'transparent';
          ctx.fillRect(x, y, s, s);
        }
      }
      const imgs = await Promise.all(thumbs.map(loadImage));
      imgs.forEach((img, i) => {
        if (!img) return;
        const col = i % cols;
        const row = Math.floor(i / cols);
        ctx.drawImage(img, pad + col * step, pad + row * step, cell, cell);
      });
    }

    return () => clearTimeout(handle);
  }, [thumbs.join('|'), padding, scale]); // eslint-disable-line react-hooks/exhaustive-deps

  if (thumbs.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center rounded border border-dashed text-xs text-muted-foreground">
        {t('export.preview.empty')}
      </div>
    );
  }

  return (
    <div className="max-h-52 overflow-auto rounded border bg-background/50 p-2">
      <canvas ref={canvasRef} className="mx-auto block" style={{ imageRendering: 'pixelated' }} />
    </div>
  );
}
