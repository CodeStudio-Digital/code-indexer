/**
 * Unit tests for the generate-route body→job-params mapping (edit flows).
 * Pins the wire contract: kind routing, n clamps, snapshot shape, reference
 * image + mask assembly and the packVariants:false quality rule for edits.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SPRITE_STYLE } from '@mcp/store/sprite-studio/types.js';
import {
  buildEditJobParams,
  buildGenerationRefs,
  clampVariantCount,
  editKindOf,
  editRequestSnapshot,
} from '../generate-body.js';

const PNG = Buffer.from('fake-png-bytes');
const id = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('editKindOf', () => {
  it('routes only inpaint/enhance to the edit flow', () => {
    expect(editKindOf({ kind: 'inpaint' })).toBe('inpaint');
    expect(editKindOf({ kind: 'enhance' })).toBe('enhance');
    expect(editKindOf({ kind: 'generation' })).toBeNull();
    expect(editKindOf({ kind: 'generate' })).toBeNull();
    expect(editKindOf({})).toBeNull();
  });
});

describe('clampVariantCount', () => {
  it('defaults to 1 and clamps to [1..max]', () => {
    expect(clampVariantCount(undefined, 4)).toBe(1);
    expect(clampVariantCount(0, 4)).toBe(1);
    expect(clampVariantCount(9, 4)).toBe(4);
    expect(clampVariantCount(9, 8)).toBe(8);
    expect(clampVariantCount(2, 4)).toBe(2);
  });
});

describe('editRequestSnapshot', () => {
  it('persists the edit provenance (kind, versionId, hasMask)', () => {
    const snap = editRequestSnapshot('inpaint', {
      prompt: 'swap the sword for an axe', n: 2, assetId: id(7), versionId: id(31),
      maskBase64: 'AAAA', rawPrompt: true,
    });
    expect(snap).toEqual({
      n: 2, rawPrompt: true, seed: null, kind: 'inpaint', versionId: id(31), hasMask: true,
    });
  });

  it('records maskless enhance + reserved strength when provided', () => {
    const snap = editRequestSnapshot('enhance', { prompt: 'p', versionId: id(3), strength: 0.6 });
    expect(snap).toMatchObject({ n: 1, kind: 'enhance', hasMask: false, strength: 0.6 });
  });
});

describe('buildEditJobParams', () => {
  it('rides the version PNG as reference, attaches the mask, disables packing', () => {
    const params = buildEditJobParams(
      { prompt: 'more contrast', n: 3, versionId: id(5), maskBase64: 'QUJD', rawPrompt: true, seed: 42 },
      DEFAULT_SPRITE_STYLE,
      PNG,
    );
    expect(params.intent).toBe('more contrast');
    expect(params.n).toBe(3);
    expect(params.rawPrompt).toBe(true);
    expect(params.seed).toBe(42);
    expect(params.referenceImages).toEqual([
      { base64: PNG.toString('base64'), mediaType: 'image/png' },
    ]);
    expect(params.mask).toEqual({ base64: 'QUJD', mediaType: 'image/png' });
    expect(params.packVariants).toBe(false);
  });

  it('omits the mask when absent and clamps n to 4', () => {
    const params = buildEditJobParams(
      { prompt: 'p', n: 99, versionId: id(5), seed: null },
      DEFAULT_SPRITE_STYLE,
      PNG,
    );
    expect(params.mask).toBeUndefined();
    expect(params.n).toBe(4);
    expect(params.seed).toBeUndefined();
    expect(params.packVariants).toBe(false);
  });
});

describe('buildGenerationRefs', () => {
  const png = (versionId: string) => Buffer.from(`png-${versionId}`);
  const reader = (ok: string[]) => (versionId: string) =>
    (ok.includes(versionId) ? png(versionId) : null);

  it('orders current → referenceIds → uploads and caps at 3', async () => {
    const refs = await buildGenerationRefs(
      {
        useCurrentAsRef: true,
        referenceIds: [id(10), id(11)],
        uploadRefs: [{ base64: 'dXA=', mediaType: 'image/png' }],
      },
      reader([id(5), id(10), id(11)]),
      id(5),
    );
    expect(refs).toHaveLength(3);
    expect(Buffer.from(refs[0].base64, 'base64').toString()).toBe(`png-${id(5)}`);
    expect(Buffer.from(refs[1].base64, 'base64').toString()).toBe(`png-${id(10)}`);
    expect(Buffer.from(refs[2].base64, 'base64').toString()).toBe(`png-${id(11)}`);
  });

  it('dedupes the current version against referenceIds and skips unreadable versions', async () => {
    const refs = await buildGenerationRefs(
      {
        useCurrentAsRef: true,
        referenceIds: [id(5), id(99)],
        uploadRefs: [{ base64: 'dXA=', mediaType: 'image/webp' }],
      },
      reader([id(5)]),
      id(5),
    );
    expect(refs).toHaveLength(2); // 5 once + upload; 99 unreadable (wrong project) dropped
    expect(refs[1].mediaType).toBe('image/webp');
  });

  it('returns [] with no inputs (legacy generation unchanged)', async () => {
    await expect(buildGenerationRefs({}, reader([]), null)).resolves.toHaveLength(0);
  });
});
