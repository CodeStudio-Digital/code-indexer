/**
 * Viewport presets + resolver for the agent preview window (DevTools device
 * mode). Kept separate from service.ts to stay under the LOC cap.
 */
import type { Viewport } from './cdp.js';

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
