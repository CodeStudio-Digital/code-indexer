import {
  DEFAULT_STUDIO_SETTINGS,
  type BackgroundMode,
  type DetailLevel,
  type LightDirection,
  type OutlineStyle,
  type PaletteMode,
  type Perspective,
  type Proportions,
  type Shading,
  type StudioSettings,
} from './types.js';

type UnknownRecord = Record<string, unknown>;

const PALETTE_MODES = ['fixed', 'maxColors', 'free'] as const satisfies readonly PaletteMode[];
const PERSPECTIVES = ['side', 'top-down', 'three-quarter', 'isometric'] as const satisfies readonly Perspective[];
const LIGHT_DIRECTIONS = ['top-left', 'top', 'top-right', 'front'] as const satisfies readonly LightDirection[];
const OUTLINE_STYLES = ['none', 'black', 'colored', 'selective'] as const satisfies readonly OutlineStyle[];
const PROPORTIONS = ['chibi', 'compact', 'heroic', 'realistic', 'custom'] as const satisfies readonly Proportions[];
const DETAIL_LEVELS = ['low', 'medium', 'high'] as const satisfies readonly DetailLevel[];
const SHADING_STYLES = ['flat', 'two-tone', 'soft', 'dithered', 'cel'] as const satisfies readonly Shading[];
const BACKGROUNDS = ['transparent', 'keyColor', 'scene'] as const satisfies readonly BackgroundMode[];

function record(value: unknown): UnknownRecord {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function enumValue<T extends string>(
  value: unknown,
  options: readonly T[],
  fallback: T,
): T {
  return typeof value === 'string' && (options as readonly string[]).includes(value)
    ? value as T
    : fallback;
}

function stringList(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  return values
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Canonicalize the runtime payload before it enters React state. Older
 * backends returned SpriteStyleConfig here (keyword strings, enum
 * antiAliasing, optional palette fields), despite the dashboard contract
 * requiring StudioSettings.
 */
export function normalizeStudioSettings(input: unknown): StudioSettings {
  const source = record(input);
  const canvas = record(source.canvas);
  const palette = record(source.palette);
  const outline = record(source.outline);
  const defaults = DEFAULT_STUDIO_SETTINGS;

  return {
    canvas: {
      width: finiteNumber(canvas.width, defaults.canvas.width),
      height: finiteNumber(canvas.height, defaults.canvas.height),
      workingSize: finiteNumber(canvas.workingSize, defaults.canvas.workingSize),
    },
    pixelPerfect: typeof source.pixelPerfect === 'boolean'
      ? source.pixelPerfect
      : defaults.pixelPerfect,
    palette: {
      mode: enumValue(palette.mode, PALETTE_MODES, defaults.palette.mode),
      colors: stringList(palette.colors),
      maxColors: typeof palette.maxColors === 'number' && Number.isFinite(palette.maxColors)
        ? palette.maxColors
        : null,
      presetName: typeof palette.presetName === 'string' ? palette.presetName : null,
    },
    perspective: enumValue(source.perspective, PERSPECTIVES, defaults.perspective),
    light: enumValue(source.light, LIGHT_DIRECTIONS, defaults.light),
    outline: {
      style: enumValue(outline.style, OUTLINE_STYLES, defaults.outline.style),
      thickness: finiteNumber(outline.thickness, defaults.outline.thickness),
    },
    proportions: enumValue(source.proportions, PROPORTIONS, defaults.proportions),
    detailLevel: source.detailLevel === 'minimal'
      ? 'low'
      : enumValue(source.detailLevel, DETAIL_LEVELS, defaults.detailLevel),
    shading: enumValue(source.shading, SHADING_STYLES, defaults.shading),
    antiAliasing: typeof source.antiAliasing === 'boolean'
      ? source.antiAliasing
      : source.antiAliasing === 'internal-only' || source.antiAliasing === 'full',
    background: enumValue(source.background, BACKGROUNDS, defaults.background),
    styleKeywords: stringList(source.styleKeywords),
    negativeKeywords: stringList(source.negativeKeywords),
  };
}
