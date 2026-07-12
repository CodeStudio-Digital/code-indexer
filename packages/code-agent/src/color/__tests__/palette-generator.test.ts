import { describe, expect, it } from 'vitest';
import {
  generateHarmony,
  generatePalette,
  generatePaletteDetailed,
  hexToOklch,
  oklchToHex,
  SHADE_KEYS,
  toCssVariables,
} from '../palette-generator.js';

describe('palette generator', () => {
  it('generates the complete Tailwind shade range and preserves the anchor', () => {
    const palette = generatePalette('#67d722');

    expect(Object.keys(palette).map(Number)).toEqual([...SHADE_KEYS]);
    expect(palette[500]).toBe('#67D722');
    const siteReference = {
      50: '#F2FDE8',
      100: '#E1FACD',
      200: '#C5F5A1',
      300: '#A0EB6B',
      400: '#7DDD3E',
      500: '#67D722',
      600: '#459C14',
      700: '#367714',
      800: '#2E5E16',
      900: '#295017',
      950: '#122C07',
    } as const;
    expect(palette).toEqual(siteReference);
  });

  it('infers a light input anchor and tracks the site reference profile', () => {
    const generated = generatePaletteDetailed('#F4FDED');
    expect(generated.anchor).toBe(50);
    expect(generated.referenceFamily).toBe('Lime');
    const siteReference = {
      50: '#F4FDED', 100: '#E0F9CE', 200: '#C3F3A3', 300: '#9CE96D',
      400: '#79DA41', 500: '#59C022', 600: '#429917', 700: '#347516',
      800: '#2C5D17', 900: '#274F18', 950: '#112B08',
    } as const;
    expect(generated.palette).toEqual(siteReference);
  });

  it.each([
    ['#2563EB', 600, 'Blue'],
    ['#F59E0B', 500, 'Amber'],
    ['#F5F5F4', 100, 'Stone'],
  ] as const)('preserves known reference colors exactly: %s', (color, anchor, family) => {
    const generated = generatePaletteDetailed(color);
    expect(generated.anchor).toBe(anchor);
    expect(generated.referenceFamily).toBe(family);
    expect(generated.palette[anchor]).toBe(color);
  });

  it.each(['#808080', '#101010', '#FF0080', '#00FFFF', '#123456', '#FFFFFF', '#000000'])(
    'produces a complete, valid and lightness-ordered scale for %s',
    color => {
      const generated = generatePaletteDetailed(color);
      const values = SHADE_KEYS.map(shade => generated.palette[shade]);
      expect(values).toHaveLength(11);
      expect(values.every(value => /^#[0-9A-F]{6}$/.test(value))).toBe(true);
      expect(generated.palette[generated.anchor]).toBe(color);
      const lightness = values.map(hex => hexToOklch(hex).l);
      expect(lightness.every((value, index) => index === 0 || value <= lightness[index - 1] + 0.001)).toBe(true);
    },
  );

  it('round-trips an sRGB color through OKLCH', () => {
    expect(oklchToHex(hexToOklch('#2563eb'))).toBe('#2563EB');
  });

  it('produces distinct complementary colors', () => {
    const harmony = generateHarmony('#67d722', 'complementary');
    expect(harmony).toHaveLength(2);
    expect(harmony[0]).toBe('#67D722');
    expect(harmony[1]).not.toBe(harmony[0]);
  });

  it('exports CSS variables', () => {
    const css = toCssVariables(generatePalette('#67d722'));
    expect(css).toContain('--color-primary-50: #F2FDE8;');
    expect(css).toContain('--color-primary-950: #122C07;');
  });

  it('rejects invalid colors', () => {
    expect(() => generatePalette('green')).toThrow('Invalid HEX color');
  });
});
