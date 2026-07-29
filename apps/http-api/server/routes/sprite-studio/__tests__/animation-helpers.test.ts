/**
 * Unit tests for the animation-route helpers: the anchor-version resolution
 * used by POST frames/generate (explicit body anchor validated against the
 * asset vs. current-version fallback) and the provenance fields toAnimDto
 * projects out of settings_json (anchorVersionId / lastGenJobId).
 */
import { describe, expect, it } from 'vitest';
import type {
  SpriteAnimationFileRow,
  SpriteFrameFileRow,
} from '../../../sprite-files.js';
import { clampFrames, MAX_FRAMES, pickAnchorVersion, toAnimDto } from '../animation-helpers.js';

const id = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
type V = { id: string; asset_id: string };
const versions: V[] = [
  { id: id(10), asset_id: id(1) },
  { id: id(11), asset_id: id(1) },
  { id: id(20), asset_id: id(2) }, // another asset — must be rejected
];
const getVersion = (versionId: string): V | null =>
  versions.find((version) => version.id === versionId) ?? null;

describe('pickAnchorVersion', () => {
  it('resolves an explicit anchor belonging to the asset', async () => {
    const r = await pickAnchorVersion(getVersion, id(1), id(10), id(11));
    expect(r).toEqual({ ok: true, version: versions[1], explicit: true });
  });

  it('rejects an anchor from another asset', async () => {
    await expect(pickAnchorVersion(getVersion, id(1), id(10), id(20)))
      .resolves.toEqual({ ok: false });
  });

  it('rejects unknown ids and non-string values', async () => {
    await expect(pickAnchorVersion(getVersion, id(1), id(10), id(999)))
      .resolves.toEqual({ ok: false });
    await expect(pickAnchorVersion(getVersion, id(1), id(10), 11))
      .resolves.toEqual({ ok: false });
  });

  it('falls back to the current version when omitted (implicit, not explicit)', async () => {
    await expect(pickAnchorVersion(getVersion, id(1), id(10), undefined))
      .resolves.toEqual({ ok: true, version: versions[0], explicit: false });
    await expect(pickAnchorVersion(getVersion, id(1), id(10), null))
      .resolves.toEqual({ ok: true, version: versions[0], explicit: false });
  });

  it('yields no version when the asset has no current (unconditioned generation)', async () => {
    await expect(pickAnchorVersion(getVersion, id(1), null, undefined))
      .resolves.toEqual({ ok: true, version: null, explicit: false });
  });
});

function animRow(settings: Record<string, unknown>): SpriteAnimationFileRow {
  return {
    id: id(5), asset_id: id(1), name: 'walk', fps: 8, loop_mode: 'loop', status: 'draft',
    settings, created_at: '2026-07-01', updated_at: '2026-07-02',
  };
}

const frame: SpriteFrameFileRow = {
  id: id(7), animation_id: id(5), frame_index: 0, version_id: id(10), duration_ms: 125, track: 0,
};

describe('toAnimDto provenance fields', () => {
  it('exposes anchorVersionId and lastGenJobId from settings_json', () => {
    const dto = toAnimDto(animRow({
      frameCount: 6,
      anchorVersionId: id(11),
      lastGenJobId: id(42),
    }), [frame]);
    expect(dto.anchorVersionId).toBe(id(11));
    expect(dto.lastGenJobId).toBe(id(42));
    expect(dto.frameCount).toBe(1); // frames win over the settings target
  });

  it('nulls both when absent or non-numeric (legacy rows)', () => {
    const dto = toAnimDto(animRow({ frameCount: 4, anchorVersionId: 'x' }), []);
    expect(dto.anchorVersionId).toBeNull();
    expect(dto.lastGenJobId).toBeNull();
  });

  it('exposes loop-range markers from settings_json (null when absent)', () => {
    const dto = toAnimDto(animRow({ frameCount: 6, loopStart: 1, loopEnd: 4 }), []);
    expect(dto.loopStart).toBe(1);
    expect(dto.loopEnd).toBe(4);
    expect(toAnimDto(animRow({ frameCount: 6 }), []).loopStart).toBeNull();
  });
});

describe('clampFrames — the raised 12-frame ceiling', () => {
  it('caps at MAX_FRAMES=12 and floors at 2', () => {
    expect(MAX_FRAMES).toBe(12);
    expect(clampFrames(20, 4)).toBe(12);
    expect(clampFrames(12, 4)).toBe(12);
    expect(clampFrames(1, 4)).toBe(2);
    expect(clampFrames(7, 4)).toBe(7);
  });

  it('uses the fallback for non-numeric input', () => {
    expect(clampFrames(undefined, 6)).toBe(6);
    expect(clampFrames('nope', 4)).toBe(4);
  });
});
