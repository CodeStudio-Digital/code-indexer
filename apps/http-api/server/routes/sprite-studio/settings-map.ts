/**
 * Impedance layer between the dashboard's `StudioSettings` (the UI contract)
 * and the store's `SpriteStyleConfig` (what the job runner's prompt template
 * consumes). http-api must not import dashboard types, so the UI shape is
 * mirrored structurally here and parsed defensively.
 *
 * Persistence strategy: the raw UI settings object is stored verbatim in
 * the Sprite bundle's `project.json` (lossless round-trip for the UI), and a
 * derived `SpriteStyleConfig` is written to `style_json` on every settings
 * write (consumed by generation). GET returns settings_json when present,
 * falling back to a config→UI derivation for older rows.
 */
import { DEFAULT_SPRITE_STYLE, type SpriteStyleConfig } from '@mcp/store/sprite-studio/types.js';

/** Structural mirror of the dashboard StudioSettings (see apps/dashboard/features/sprite-studio/types.ts). */
export interface StudioSettingsShape {
  canvas: { width: number; height: number; workingSize: number };
  pixelPerfect: boolean;
  palette: { mode: 'fixed' | 'maxColors' | 'free'; colors: string[]; maxColors: number | null; presetName: string | null };
  perspective: SpriteStyleConfig['perspective'];
  light: string;
  outline: { style: SpriteStyleConfig['outline']['style']; thickness: number };
  proportions: string;
  detailLevel: SpriteStyleConfig['detailLevel'];
  shading: string;
  antiAliasing: boolean;
  background: SpriteStyleConfig['background'];
  keyColor?: string;
  styleKeywords: string[];
  negativeKeywords: string[];
}

/** Derive the store style contract from the UI settings (defensive: fills gaps from defaults). */
export function studioSettingsToStyle(input: unknown): SpriteStyleConfig {
  const s = (input ?? {}) as Partial<StudioSettingsShape>;
  const d = DEFAULT_SPRITE_STYLE;
  const palette = s.palette ?? { mode: 'free', colors: [], maxColors: null, presetName: null };
  return {
    canvas: {
      width: num(s.canvas?.width, d.canvas.width),
      height: num(s.canvas?.height, d.canvas.height),
      workingSize: num(s.canvas?.workingSize, d.canvas.workingSize),
    },
    pixelPerfect: bool(s.pixelPerfect, d.pixelPerfect),
    palette: {
      mode: palette.mode ?? 'free',
      colors: Array.isArray(palette.colors) && palette.colors.length ? palette.colors : undefined,
      maxColors: palette.maxColors ?? undefined,
      presetName: palette.presetName ?? undefined,
    },
    perspective: s.perspective ?? d.perspective,
    light: s.light ?? d.light,
    outline: { style: s.outline?.style ?? d.outline.style, thickness: num(s.outline?.thickness, d.outline.thickness) },
    proportions: s.proportions ?? d.proportions,
    detailLevel: s.detailLevel ?? d.detailLevel,
    shading: s.shading ?? d.shading,
    // UI boolean → enum: on = full smoothing, off = pure pixel art.
    antiAliasing: s.antiAliasing === true ? 'full' : 'none',
    background: s.background ?? d.background,
    keyColor: s.keyColor,
    styleKeywords: joinKeywords(s.styleKeywords),
    negativeKeywords: joinKeywords(s.negativeKeywords),
  };
}

/** Derive UI settings from the store style contract (fallback when settings_json is absent). */
export function styleToStudioSettings(style: SpriteStyleConfig): StudioSettingsShape {
  return {
    canvas: { ...style.canvas },
    pixelPerfect: style.pixelPerfect,
    palette: {
      mode: style.palette.mode,
      colors: style.palette.colors ?? [],
      maxColors: style.palette.maxColors ?? null,
      presetName: style.palette.presetName ?? null,
    },
    perspective: style.perspective,
    light: style.light,
    outline: { ...style.outline },
    proportions: style.proportions,
    detailLevel: style.detailLevel,
    shading: style.shading,
    antiAliasing: style.antiAliasing !== 'none',
    background: style.background,
    keyColor: style.keyColor,
    styleKeywords: splitKeywords(style.styleKeywords),
    negativeKeywords: splitKeywords(style.negativeKeywords),
  };
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}
function joinKeywords(v: unknown): string {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x.trim()).join(', ');
  return typeof v === 'string' ? v : '';
}
function splitKeywords(v: string): string[] {
  return v ? v.split(',').map((x) => x.trim()).filter(Boolean) : [];
}
