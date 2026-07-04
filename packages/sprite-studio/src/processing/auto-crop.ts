import type { CanvasAlign, CanvasAnchorX, CanvasAnchorY, RgbaImage } from './types.js';

export interface CenterOnCanvasParams {
  width: number;
  height: number;
  /** 'center' (default) or 'bottom' (feet-on-ground for characters). */
  align?: CanvasAlign;
}

/**
 * Crop to the bounding box of alpha>0 pixels. A fully transparent image is
 * returned unchanged (as a copy).
 */
export function autoCrop(img: RgbaImage): RgbaImage {
  const { rgba, width, height } = img;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { rgba: new Uint8Array(rgba), width, height };
  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;
  const out = new Uint8Array(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    const srcStart = ((minY + y) * width + minX) * 4;
    out.set(rgba.subarray(srcStart, srcStart + cw * 4), y * cw * 4);
  }
  return { rgba: out, width: cw, height: ch };
}

/**
 * Place the image on a transparent canvas of the given size, centered
 * horizontally and centered or bottom-aligned vertically. Content that
 * falls outside the canvas is clipped.
 */
export function centerOnCanvas(img: RgbaImage, params: CenterOnCanvasParams): RgbaImage {
  const { width, height } = params;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`Invalid canvas dimensions: ${width}x${height}`);
  }
  const align = params.align ?? 'center';
  const ox = Math.round((width - img.width) / 2);
  const oy = align === 'bottom' ? height - img.height : Math.round((height - img.height) / 2);
  return blitOnCanvas(img, width, height, ox, oy);
}

export interface PlaceOnCanvasParams {
  width: number;
  height: number;
  /** Horizontal anchor (default 'center'). */
  anchorX?: CanvasAnchorX;
  /** Vertical anchor (default 'middle'). */
  anchorY?: CanvasAnchorY;
}

/**
 * Place the image on a transparent canvas of the given size at any of the
 * 9 anchor positions (registration tool for animation frames). 'center' +
 * 'middle'/'bottom' reproduce centerOnCanvas exactly — that older helper is
 * kept as-is for back-compat. Content outside the canvas is clipped.
 */
export function placeOnCanvas(img: RgbaImage, params: PlaceOnCanvasParams): RgbaImage {
  const { width, height } = params;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`Invalid canvas dimensions: ${width}x${height}`);
  }
  const anchorX = params.anchorX ?? 'center';
  const anchorY = params.anchorY ?? 'middle';
  const ox =
    anchorX === 'left' ? 0 : anchorX === 'right' ? width - img.width : Math.round((width - img.width) / 2);
  const oy =
    anchorY === 'top' ? 0 : anchorY === 'bottom' ? height - img.height : Math.round((height - img.height) / 2);
  return blitOnCanvas(img, width, height, ox, oy);
}

/** Clipped copy of `img` onto a fresh transparent width×height canvas at (ox,oy). */
function blitOnCanvas(img: RgbaImage, width: number, height: number, ox: number, oy: number): RgbaImage {
  const out = new Uint8Array(width * height * 4);
  for (let sy = 0; sy < img.height; sy++) {
    const dy = oy + sy;
    if (dy < 0 || dy >= height) continue;
    const sxStart = Math.max(0, -ox);
    const sxEnd = Math.min(img.width, width - ox);
    if (sxEnd <= sxStart) continue;
    const srcStart = (sy * img.width + sxStart) * 4;
    const dstStart = (dy * width + (ox + sxStart)) * 4;
    out.set(img.rgba.subarray(srcStart, srcStart + (sxEnd - sxStart) * 4), dstStart);
  }
  return { rgba: out, width, height };
}
