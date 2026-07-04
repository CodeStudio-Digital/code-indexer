/**
 * Roundtrip tests for the version drag payload (inspector Versions row →
 * animation timeline drop). A minimal DataTransfer stub is enough — the
 * helpers only touch setData/getData/types/effectAllowed.
 */
import { describe, expect, it } from 'vitest';
import {
  hasVersionDragData,
  readVersionDragData,
  setVersionDragData,
  SPRITE_VERSION_MIME,
} from '../version-drag.js';

function fakeDataTransfer(): DataTransfer {
  const store = new Map<string, string>();
  return {
    effectAllowed: 'none',
    get types() { return [...store.keys()]; },
    setData: (type: string, data: string) => { store.set(type, data); },
    getData: (type: string) => store.get(type) ?? '',
  } as unknown as DataTransfer;
}

describe('version-drag payload', () => {
  it('roundtrips set → has → read and marks the drag as copy', () => {
    const dt = fakeDataTransfer();
    expect(hasVersionDragData(dt)).toBe(false);

    setVersionDragData(dt, { versionId: 15, assetId: 3, version: 13, label: 'v013' });
    expect(dt.effectAllowed).toBe('copy');
    expect(hasVersionDragData(dt)).toBe(true);
    expect(readVersionDragData(dt)).toEqual({ versionId: 15, assetId: 3, version: 13, label: 'v013' });
  });

  it('uses a dedicated MIME so asset/OS drags never collide', () => {
    const dt = fakeDataTransfer();
    dt.setData('application/x-sprite-asset', JSON.stringify({ assetId: 1, slug: 'hero' }));
    dt.setData('text/plain', 'not-a-version');
    expect(SPRITE_VERSION_MIME).toBe('application/x-sprite-version');
    expect(hasVersionDragData(dt)).toBe(false);
    expect(readVersionDragData(dt)).toBeNull();
  });

  it('returns null for malformed or type-mangled payloads', () => {
    const broken = fakeDataTransfer();
    broken.setData(SPRITE_VERSION_MIME, '{not json');
    expect(readVersionDragData(broken)).toBeNull();

    const wrongTypes = fakeDataTransfer();
    wrongTypes.setData(SPRITE_VERSION_MIME, JSON.stringify({ versionId: '15', assetId: 3 }));
    expect(readVersionDragData(wrongTypes)).toBeNull();
  });

  it('defaults version/label when a partial payload arrives', () => {
    const dt = fakeDataTransfer();
    dt.setData(SPRITE_VERSION_MIME, JSON.stringify({ versionId: 15, assetId: 3 }));
    expect(readVersionDragData(dt)).toEqual({ versionId: 15, assetId: 3, version: 0, label: '#15' });
  });
});
