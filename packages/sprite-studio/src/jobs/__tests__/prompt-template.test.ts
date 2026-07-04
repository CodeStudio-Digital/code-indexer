import { describe, expect, it } from 'vitest';
import { DEFAULT_SPRITE_STYLE, type SpriteStyleConfig } from '@mcp/store/sprite-studio/types.js';
import { buildFinalPrompt, buildNegative, compileStyleBlock, REFERENCE_SUFFIX, STYLE_SUFFIX } from '../prompt-template.js';

const baseStyle: SpriteStyleConfig = {
  ...DEFAULT_SPRITE_STYLE,
  palette: { mode: 'fixed', colors: ['#1a1c2c', '#5d275d', '#b13e53'] },
  perspective: 'three-quarter',
};

describe('compileStyleBlock', () => {
  it('contains palette hexes, perspective and the no-text suffix', () => {
    const block = compileStyleBlock(baseStyle);
    expect(block).toContain('#1a1c2c');
    expect(block).toContain('#5d275d');
    expect(block).toContain('#b13e53');
    expect(block).toContain('three-quarter view');
    expect(block).toContain('32x32 pixel grid');
    expect(block).toContain('lit from top-left');
    expect(block.endsWith(STYLE_SUFFIX)).toBe(true);
  });

  it('describes maxColors palettes as a limited palette', () => {
    const block = compileStyleBlock({
      ...baseStyle,
      palette: { mode: 'maxColors', maxColors: 16 },
    });
    expect(block).toContain('limited palette of 16 colors');
  });

  it('emits key-color background instruction for keyColor styles', () => {
    const block = compileStyleBlock({ ...baseStyle, background: 'keyColor' });
    expect(block).toContain('plain solid #FF00FF background');
  });

  it('emits transparent-background isolation for transparent styles', () => {
    const block = compileStyleBlock({ ...baseStyle, background: 'transparent' });
    expect(block).toContain('transparent background');
    expect(block).toContain('no scene');
  });

  it('caps at ~150 words, trimming keywords but never the suffix', () => {
    const block = compileStyleBlock({
      ...baseStyle,
      styleKeywords: Array.from({ length: 400 }, (_, i) => `kw${i}`).join(' '),
    });
    const words = block.split(/\s+/).filter(Boolean);
    expect(words.length).toBeLessThanOrEqual(150);
    expect(block.endsWith(STYLE_SUFFIX)).toBe(true);
  });
});

describe('buildFinalPrompt', () => {
  it('joins intent and style block with a blank line', () => {
    const prompt = buildFinalPrompt('  a goblin chef  ', baseStyle);
    expect(prompt.startsWith('a goblin chef\n\n')).toBe(true);
    expect(prompt).toContain('#1a1c2c');
  });
});

describe('compileStyleBlock — reference mode (fidelity path)', () => {
  it('slims the block: keeps canvas + background, defers style to the image', () => {
    const block = compileStyleBlock(baseStyle, { hasReferences: true });
    expect(block).toContain('reference image');
    expect(block).toContain('32x32 pixel grid');
    expect(block.endsWith(REFERENCE_SUFFIX)).toBe(true);
    // The prose that fights the reference must be GONE:
    expect(block).not.toContain('lit from');
    expect(block).not.toContain('proportions');
    expect(block).not.toContain('three-quarter view');
    expect(block).not.toContain('#1a1c2c'); // palette comes from the image
    expect(block).not.toContain('shading');
  });

  it('buildFinalPrompt forwards the reference flag', () => {
    const p = buildFinalPrompt('a goblin', baseStyle, { hasReferences: true });
    expect(p.startsWith('a goblin')).toBe(true);
    expect(p).toContain('reference image');
    expect(p).not.toContain('lit from');
  });
});

describe('buildNegative', () => {
  it('always includes the default negatives', () => {
    const neg = buildNegative(baseStyle);
    for (const term of ['blurry', 'photorealistic', '3d render', 'extra limbs', 'text', 'watermark', 'multiple characters']) {
      expect(neg).toContain(term);
    }
  });

  it('puts project keywords first and dedupes against defaults', () => {
    const neg = buildNegative({ ...baseStyle, negativeKeywords: 'guns, Blurry' });
    expect(neg.startsWith('guns, Blurry')).toBe(true);
    expect(neg.toLowerCase().match(/blurry/g)).toHaveLength(1);
  });
});

describe('buildPostOps — free-palette quantize scales with canvas', () => {
  it('quantizes at ≤64px but keeps full color at 256px (hand-painted look)', async () => {
    const { buildPostOps } = await import('../generation-request.js');
    const small = buildPostOps({ ...DEFAULT_SPRITE_STYLE }, { intent: 'x', style: DEFAULT_SPRITE_STYLE }, false, '#FF00FF');
    expect(small.some((o) => o.op === 'quantize')).toBe(true);
    const bigStyle = { ...DEFAULT_SPRITE_STYLE, canvas: { width: 256, height: 256, workingSize: 1024 } };
    const big = buildPostOps(bigStyle, { intent: 'x', style: bigStyle }, false, '#FF00FF');
    expect(big.some((o) => o.op === 'quantize')).toBe(false);
    expect(big.some((o) => o.op === 'fitToCanvas')).toBe(true); // framing stays
  });
});
