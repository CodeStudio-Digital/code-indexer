/**
 * Viewport presets + resolver for the agent preview window (DevTools device
 * mode). Kept separate from service.ts to stay under the LOC cap.
 */
import { screen } from 'electron';
import type { PreviewWindow, Viewport } from './cdp.js';

/** Named viewport presets (DevTools device-mode style). */
export const VIEWPORT_PRESETS: Record<string, Viewport> = {
  fullhd: { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false },
  hd: { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false },
  laptop: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
  desktop: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
  tablet: { width: 768, height: 1024, deviceScaleFactor: 2, mobile: true },
  mobile: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
};
const DEFAULT_WIDTH = 1366;
const DEFAULT_HEIGHT = 768;

/** Resolve a {preset|width|height|deviceScaleFactor|mobile} request → Viewport. */
export function resolveViewport(args: Record<string, unknown>, base: Viewport): Viewport {
  const preset = typeof args.preset === 'string' ? VIEWPORT_PRESETS[args.preset.toLowerCase()] : undefined;
  const start = preset ?? base;
  const finite = (value: unknown, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    width: args.width != null ? finite(args.width, start.width) : start.width,
    height: args.height != null ? finite(args.height, start.height) : start.height,
    deviceScaleFactor: args.deviceScaleFactor != null ? finite(args.deviceScaleFactor, start.deviceScaleFactor) : start.deviceScaleFactor,
    mobile: args.mobile != null ? !!args.mobile : start.mobile,
  };
}

/** Clamp a desired content size to the primary display work area. */
export function clampToScreen(w: number, h: number): { width: number; height: number } {
  const wa = screen.getPrimaryDisplay().workAreaSize;
  const width = Number.isFinite(w) ? w : DEFAULT_WIDTH;
  const height = Number.isFinite(h) ? h : DEFAULT_HEIGHT;
  return { width: Math.round(Math.min(Math.max(320, width), wa.width)), height: Math.round(Math.min(Math.max(320, height), wa.height)) };
}

/**
 * Apply a viewport by resizing the OS window's CONTENT area (native, crash-safe)
 * — width-based responsive breakpoints react. Clamped to the screen work area.
 * No CDP device-metrics override (that destabilised Chromium on some
 * Windows/Electron builds), so true touch/mobile-UA emulation is deferred.
 */
export function applyViewport(pw: PreviewWindow, v: Viewport): Viewport {
  const requestedWidth = v.width;
  const requestedHeight = v.height;
  let actual = clampToScreen(v.width, v.height);
  if (!pw.win.isDestroyed()) {
    try {
      pw.win.setContentSize(actual.width, actual.height);
      const [width, height] = pw.win.getContentSize();
      actual = { width, height };
    } catch { /* best-effort */ }
  }
  const applied: Viewport = {
    ...v,
    width: actual.width,
    height: actual.height,
    requestedWidth,
    requestedHeight,
    emulated: false,
  };
  pw.viewport = applied;
  return applied;
}
