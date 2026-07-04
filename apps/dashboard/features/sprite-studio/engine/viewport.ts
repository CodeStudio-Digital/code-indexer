/**
 * Pan/zoom transform between screen space (CSS px) and image space.
 * When `pixelPerfect` is on, zoom ≥ 1 snaps to the integer ladder
 * [1,2,3,4,8,16,32] so pixels stay square and crisp; below 1 zoom is free
 * (fit-to-window needs fractional zoom).
 */
export const ZOOM_LADDER = [1, 2, 3, 4, 8, 16, 32] as const;

export const MIN_ZOOM = 1 / 16;
export const MAX_ZOOM = 32;

export interface Point {
  x: number;
  y: number;
}

export class Viewport {
  zoom = 1;
  panX = 0;
  panY = 0;
  pixelPerfect = true;

  screenToImage(sx: number, sy: number): Point {
    return { x: (sx - this.panX) / this.zoom, y: (sy - this.panY) / this.zoom };
  }

  imageToScreen(ix: number, iy: number): Point {
    return { x: ix * this.zoom + this.panX, y: iy * this.zoom + this.panY };
  }

  panBy(dx: number, dy: number): void {
    this.panX += dx;
    this.panY += dy;
  }

  /** Set zoom keeping the image point under (cx, cy) fixed on screen. */
  setZoom(zoom: number, cx = 0, cy = 0): void {
    const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
    if (z === this.zoom) return;
    const scale = z / this.zoom;
    this.panX = cx - (cx - this.panX) * scale;
    this.panY = cy - (cy - this.panY) * scale;
    this.zoom = z;
  }

  /**
   * Wheel zoom by `factor` (>1 in, <1 out) anchored at a screen point.
   * pixelPerfect && target ≥ 1 → snap to the next ladder step in the travel
   * direction (so a single wheel notch always lands on an integer zoom).
   */
  wheelZoom(factor: number, centerX: number, centerY: number): void {
    const target = this.zoom * factor;
    this.setZoom(this.snap(target, factor > 1 ? 1 : -1), centerX, centerY);
  }

  private snap(target: number, dir: 1 | -1): number {
    if (!this.pixelPerfect || (target < 1 && this.zoom <= 1)) return target;
    const eps = 1e-6;
    if (dir > 0) {
      if (this.zoom < 1 - eps) return Math.min(1, target < 1 ? target : 1);
      for (const step of ZOOM_LADDER) if (step > this.zoom + eps) return step;
      return MAX_ZOOM;
    }
    for (let i = ZOOM_LADDER.length - 1; i >= 0; i--) {
      if (ZOOM_LADDER[i] < this.zoom - eps) return ZOOM_LADDER[i];
    }
    return target; // below ladder floor → free fractional zoom-out
  }

  /** Fit the whole image in the container, centered. Snaps DOWN to the
   *  ladder when pixelPerfect and the fit zoom is ≥ 1. */
  fit(containerW: number, containerH: number, imageW: number, imageH: number): void {
    if (imageW <= 0 || imageH <= 0 || containerW <= 0 || containerH <= 0) return;
    let z = Math.min(containerW / imageW, containerH / imageH);
    if (this.pixelPerfect && z >= 1) {
      let snapped = 1;
      for (const step of ZOOM_LADDER) if (step <= z) snapped = step;
      z = snapped;
    }
    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    this.panX = (containerW - imageW * this.zoom) / 2;
    this.panY = (containerH - imageH * this.zoom) / 2;
  }

  /** 100% zoom centered in the container. */
  zoomTo100(containerW: number, containerH: number, imageW: number, imageH: number): void {
    this.zoom = 1;
    this.panX = (containerW - imageW) / 2;
    this.panY = (containerH - imageH) / 2;
  }
}
