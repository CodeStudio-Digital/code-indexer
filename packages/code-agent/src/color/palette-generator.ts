import { REFERENCE_PALETTES } from './reference-palettes.js';
import chroma from 'chroma-js';

/**
 * Dependency-free OKLCH palette generator for Node.js or the browser.
 *
 * Usage:
 *   import { generatePalette, generateHarmony } from './palette-generator';
 *   generatePalette('#67d722');
 *
 * CLI (after compiling):
 *   node palette-generator.js '#67d722'
 */

export const SHADE_KEYS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;
export type Shade = (typeof SHADE_KEYS)[number];
export type Palette = Record<Shade, string>;
export type Oklch = { l: number; c: number; h: number };
export type Harmony =
  | 'analogous'
  | 'complementary'
  | 'split-complementary'
  | 'triadic'
  | 'tetradic'
  | 'monochromatic';

export interface PaletteOptions {
  /** Shade at which the input is preserved. By default it is inferred by lightness. */
  anchor?: Shade;
}

export interface GeneratedPalette {
  input: string;
  anchor: Shade;
  referenceFamily: string;
  palette: Palette;
}

const clamp = (n: number, min = 0, max = 1) => Math.min(max, Math.max(min, n));
const normHue = (h: number) => ((h % 360) + 360) % 360;
const srgbToLinear = (v: number) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const linearToSrgb = (v: number) => v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;

function parseHex(hex: string): [number, number, number] {
  const value = hex.trim().replace(/^#/, '');
  if (!/^(?:[\da-f]{3}|[\da-f]{6})$/i.test(value)) throw new Error(`Invalid HEX color: ${hex}`);
  const full = value.length === 3 ? [...value].map(x => x + x).join('') : value;
  return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16) / 255) as [number, number, number];
}

export function hexToOklch(hex: string): Oklch {
  const [r0, g0, b0] = parseHex(hex);
  const r = srgbToLinear(r0), g = srgbToLinear(g0), b = srgbToLinear(b0);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: L, c: Math.hypot(a, bb), h: normHue(Math.atan2(bb, a) * 180 / Math.PI) };
}

function rawOklchToRgb({ l: L, c, h }: Oklch): [number, number, number] {
  const angle = h * Math.PI / 180;
  const a = c * Math.cos(angle), b = c * Math.sin(angle);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/** Converts OKLCH to sRGB, reducing chroma when the color is outside the sRGB gamut. */
export function oklchToHex(color: Oklch): string {
  let candidate = { l: clamp(color.l), c: Math.max(0, color.c), h: normHue(color.h) };
  let rgb = rawOklchToRgb(candidate);
  if (rgb.some(v => v < 0 || v > 1)) {
    let low = 0, high = candidate.c;
    for (let i = 0; i < 18; i++) {
      const mid = (low + high) / 2;
      const test = rawOklchToRgb({ ...candidate, c: mid });
      if (test.every(v => v >= 0 && v <= 1)) low = mid; else high = mid;
    }
    candidate = { ...candidate, c: low };
    rgb = rawOklchToRgb(candidate);
  }
  return '#' + rgb.map(v => Math.round(clamp(v) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}

function perceptualDistance(a: string, b: string): number {
  return chroma.deltaE(a, b);
}

export function generatePaletteDetailed(inputHex: string, options: PaletteOptions = {}): GeneratedPalette {
  parseHex(inputHex);
  const input = chroma(inputHex);
  const normalizedInput = input.hex().toUpperCase();
  const inputSaturation = input.get('hsl.s');
  const neutralFamilies = new Set(['Slate', 'Gray', 'Zinc', 'Stone']);
  const candidates = REFERENCE_PALETTES.filter(family =>
    family.name !== 'Neutral' && (inputSaturation > 0.15 ? !neutralFamilies.has(family.name) : neutralFamilies.has(family.name)),
  );
  const family = candidates.reduce((best, candidate) => {
    const score = Math.min(...candidate.shades.map(shade => perceptualDistance(normalizedInput, shade.hexcode)));
    return score < best.score ? { family: candidate, score } : best;
  }, { family: candidates[0], score: Number.POSITIVE_INFINITY });

  const inputLightness = input.get('hsl.l');
  const inferredAnchor = family.family.shades.reduce((best, shade) =>
    Math.abs(chroma(shade.hexcode).get('hsl.l') - inputLightness) < Math.abs(chroma(best.hexcode).get('hsl.l') - inputLightness)
      ? shade
      : best,
  );
  const anchor = options.anchor ?? inferredAnchor.number;
  if (!SHADE_KEYS.includes(anchor as Shade)) throw new Error(`Unsupported anchor shade: ${anchor}`);
  const referenceAnchor = family.family.shades.find(shade => shade.number === anchor) ?? inferredAnchor;
  const referenceHue = chroma(referenceAnchor.hexcode).get('hsl.h') || 0;
  const referenceSaturation = chroma(referenceAnchor.hexcode).get('hsl.s');
  const hueDelta = input.get('hsl.h') - referenceHue;
  const saturationRatio = referenceSaturation > 0 ? inputSaturation / referenceSaturation : 1;
  const result = {} as Palette;

  for (const shade of family.family.shades) {
    const key = shade.number as Shade;
    if (key === anchor) result[key] = normalizedInput;
    else {
      const reference = chroma(shade.hexcode);
      const saturation = reference.get('hsl.s') * saturationRatio;
      let hue = (reference.get('hsl.h') + hueDelta) % 360;
      if (hue < 0) hue += 360;
      // Keep the two serialization steps: this mirrors chroma.js' quantization
      // in UI Colors and is required for exact channel-level parity.
      const withSaturation = reference.set('hsl.s', saturation).hex();
      result[key] = chroma(withSaturation).set('hsl.h', hue).hex().toUpperCase();
    }
  }
  return { input: normalizedInput, anchor: anchor as Shade, referenceFamily: family.family.name, palette: result };
}

export function generatePalette(inputHex: string, options: PaletteOptions = {}): Palette {
  return generatePaletteDetailed(inputHex, options).palette;
}

const HARMONY_OFFSETS: Record<Exclude<Harmony, 'monochromatic'>, number[]> = {
  analogous: [-30, 0, 30],
  complementary: [0, 180],
  'split-complementary': [0, 150, 210],
  triadic: [0, 120, 240],
  tetradic: [0, 90, 180, 270],
};

/** Returns base colors for a harmony; feed any result into generatePalette(). */
export function generateHarmony(inputHex: string, harmony: Harmony): string[] {
  const base = hexToOklch(inputHex);
  if (harmony === 'monochromatic') {
    return [0.72, 0.86, 1, 1.12, 1.25].map(factor => oklchToHex({
      ...base,
      l: clamp(base.l * factor, 0.12, 0.96),
      c: base.c * Math.min(1, factor),
    }));
  }
  return HARMONY_OFFSETS[harmony].map(offset => oklchToHex({ ...base, h: base.h + offset }));
}

export function toCssVariables(palette: Palette, prefix = 'color-primary'): string {
  return `:root {\n${SHADE_KEYS.map(k => `  --${prefix}-${k}: ${palette[k]};`).join('\n')}\n}`;
}

export function toTailwindObject(palette: Palette): Record<string, string> {
  return Object.fromEntries(SHADE_KEYS.map(k => [String(k), palette[k]]));
}

declare const process: { argv: string[] } | undefined;
if (typeof process !== 'undefined' && process.argv?.[1]?.match(/palette-generator\.(?:js|mjs|cjs)$/)) {
  const color = process.argv[2] ?? '#67D722';
  console.log(JSON.stringify({ color, palette: generatePalette(color) }, null, 2));
}
