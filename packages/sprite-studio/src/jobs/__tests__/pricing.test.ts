import { describe, expect, it } from 'vitest';
import { estimateCost, estimatePerImage } from '../pricing.js';

describe('estimatePerImage — family tiers', () => {
  it('prices the Gemini PRO image tier far above the flash tier', () => {
    const pro = estimatePerImage('gemini-3-pro-image');
    const proPreview = estimatePerImage('gemini-3-pro-image-preview');
    const flash = estimatePerImage('gemini-3.1-flash-image');
    const flashOld = estimatePerImage('gemini-2.5-flash-image');
    expect(pro).toBeCloseTo(0.14, 5);
    expect(proPreview).toBeCloseTo(0.14, 5);
    expect(flash).toBeCloseTo(0.039, 5);
    expect(flashOld).toBeCloseTo(0.039, 5);
    expect(pro).toBeGreaterThan(flash * 3);
  });

  it('keeps gpt-image and dall-e families on their tables', () => {
    expect(estimatePerImage('gpt-image-1')).toBeCloseTo(0.042, 5); // medium 1024
    expect(estimatePerImage('dall-e-3')).toBeCloseTo(0.04, 5);
  });

  it('scales with n', () => {
    expect(estimateCost('gemini-3.1-flash-image', 4)).toBeCloseTo(0.156, 5);
  });
});
