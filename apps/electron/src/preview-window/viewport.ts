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

/** Resolve a {preset|width|height|deviceScaleFactor|mobile} request → Viewport. */
export function resolveViewport(args: Record<string, unknown>, base: Viewport): Viewport {
  const preset = typeof args.preset === 'string' ? VIEWPORT_PRESETS[args.preset.toLowerCase()] : undefined;
  const start = preset ?? base;
  return {
    width: args.width != null ? Number(args.width) : start.width,
    height: args.height != null ? Number(args.height) : start.height,
    deviceScaleFactor: args.deviceScaleFactor != null ? Number(args.deviceScaleFactor) : start.deviceScaleFactor,
    mobile: args.mobile != null ? !!args.mobile : start.mobile,
  };
}

/** Clamp a desired content size to the primary display work area. */
export function clampToScreen(w: number, h: number): { width: number; height: number } {
  const wa = screen.getPrimaryDisplay().workAreaSize;
  return { width: Math.min(Math.max(320, w), wa.width), height: Math.min(Math.max(320, h), wa.height) };
}

/**
 * Apply a viewport by resizing the OS window's CONTENT area (native, crash-safe)
 * — width-based responsive breakpoints react. Clamped to the screen work area.
 * No CDP device-metrics override (that destabilised Chromium on some
 * Windows/Electron builds), so true touch/mobile-UA emulation is deferred.
 */
export function applyViewport(pw: PreviewWindow, v: Viewport): Viewport {
  if (!pw.win.isDestroyed()) {
    const { width, height } = clampToScreen(v.width, v.height);
    try { pw.win.setContentSize(width, height); } catch { /* best-effort */ }
  }
  pw.viewport = v;
  return v;
}
