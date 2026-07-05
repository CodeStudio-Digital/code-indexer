import { describe, expect, it } from 'vitest';
import {
  hasAssetDragData,
  readAssetDragData,
  setAssetDragData,
  SPRITE_ASSET_MIME,
} from '../library/asset-drag.js';

function fakeDataTransfer(): DataTransfer {
  const store = new Map<string, string>();
  return {
    effectAllowed: 'none',
    get types() { return [...store.keys()]; },
    setData: (type: string, data: string) => { store.set(type, data); },
    getData: (type: string) => store.get(type) ?? '',
  } as unknown as DataTransfer;
}

describe('asset-drag payload', () => {
  it('roundtrips set → has → read and marks the drag as copy', () => {
    const dt = fakeDataTransfer();
    expect(hasAssetDragData(dt)).toBe(false);

    setAssetDragData(dt, { assetId: 3, slug: 'hero', versionId: 9, thumbUrl: '/thumb.png' });
    expect(dt.effectAllowed).toBe('copy');
    expect(hasAssetDragData(dt)).toBe(true);
    expect(readAssetDragData(dt)).toEqual({ assetId: 3, slug: 'hero', versionId: 9, thumbUrl: '/thumb.png' });
  });

  it('uses a dedicated MIME so version/OS drags never collide', () => {
    const dt = fakeDataTransfer();
    dt.setData('application/x-sprite-version', JSON.stringify({ versionId: 1, assetId: 1, version: 1, label: 'v001' }));
    dt.setData('text/plain', 'not-an-asset');
    expect(SPRITE_ASSET_MIME).toBe('application/x-sprite-asset');
    expect(hasAssetDragData(dt)).toBe(false);
    expect(readAssetDragData(dt)).toBeNull();
  });

  it('rejects optional fields with wrong types', () => {
    const wrongVersion = fakeDataTransfer();
    wrongVersion.setData(SPRITE_ASSET_MIME, JSON.stringify({ assetId: 3, slug: 'hero', versionId: '9' }));
    expect(readAssetDragData(wrongVersion)).toBeNull();

    const wrongThumb = fakeDataTransfer();
    wrongThumb.setData(SPRITE_ASSET_MIME, JSON.stringify({ assetId: 3, slug: 'hero', thumbUrl: 42 }));
    expect(readAssetDragData(wrongThumb)).toBeNull();
  });
});
