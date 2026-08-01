import { describe, expect, it } from 'vitest';
import { DEFAULT_STUDIO_SETTINGS } from '../types.js';
import { normalizeStudioSettings } from '../settings-normalization.js';

describe('normalizeStudioSettings', () => {
  it('converts the persisted SpriteStyleConfig shape into the dashboard contract', () => {
    const settings = normalizeStudioSettings({
      antiAliasing: 'none',
      background: 'transparent',
      canvas: { width: 32, height: 32, workingSize: 1024 },
      detailLevel: 'medium',
      light: 'top-left',
      negativeKeywords: 'blurry, noisy',
      outline: { style: 'black', thickness: 1 },
      palette: { mode: 'free' },
      perspective: 'side',
      pixelPerfect: true,
      proportions: 'compact',
      shading: 'two-tone',
      styleKeywords: 'pixel art, 16-bit',
    });

    expect(settings.styleKeywords).toEqual(['pixel art', '16-bit']);
    expect(settings.negativeKeywords).toEqual(['blurry', 'noisy']);
    expect(settings.palette).toEqual({
      mode: 'free',
      colors: [],
      maxColors: null,
      presetName: null,
    });
    expect(settings.antiAliasing).toBe(false);
  });

  it('preserves canonical settings while removing invalid list entries', () => {
    const settings = normalizeStudioSettings({
      ...DEFAULT_STUDIO_SETTINGS,
      styleKeywords: ['pixel art', '', 42],
      negativeKeywords: [' blurry ', ''],
      palette: {
        ...DEFAULT_STUDIO_SETTINGS.palette,
        colors: [' #ffffff ', '', null],
      },
      antiAliasing: true,
    });

    expect(settings.styleKeywords).toEqual(['pixel art']);
    expect(settings.negativeKeywords).toEqual(['blurry']);
    expect(settings.palette.colors).toEqual(['#ffffff']);
    expect(settings.antiAliasing).toBe(true);
  });
});
