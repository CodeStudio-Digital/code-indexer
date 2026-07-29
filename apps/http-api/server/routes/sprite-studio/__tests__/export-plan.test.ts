import { describe, expect, it } from 'vitest';
import { normalizeExportRequest } from '../export-plan.js';

const ASSET_ID = '11111111-1111-4111-8111-111111111111';
const ANIMATION_ID = '22222222-2222-4222-8222-222222222222';

describe('normalizeExportRequest', () => {
  it('keeps v2 animation scope explicit', () => {
    expect(normalizeExportRequest({
      version: 2, format: 'godot',
      scope: { kind: 'animation', assetId: ASSET_ID, animationIds: [ANIMATION_ID] },
      target: { kind: 'project', relativeDir: 'assets/sprites' }, options: { trim: true },
    })).toMatchObject({
      version: 2,
      scope: { kind: 'animation', assetId: ASSET_ID, animationIds: [ANIMATION_ID] },
    });
  });

  it('rejects the legacy flat request contract', () => {
    expect(normalizeExportRequest({
      format: 'spritesheet-json',
      scope: 'asset',
      assetId: ASSET_ID,
      options: {},
    })).toBeNull();
  });

  it('keeps a v2 relative destination project-relative', () => {
    expect(normalizeExportRequest({
      version: 2,
      format: 'phaser',
      scope: { kind: 'asset', assetIds: [ASSET_ID] },
      target: { kind: 'project', relativeDir: 'game/sprites' },
    })?.target).toEqual({ kind: 'project', relativeDir: 'game/sprites' });
  });

  it('rejects unknown formats and incomplete animation bodies', () => {
    expect(normalizeExportRequest({ format: 'zip', scope: 'approved' })).toBeNull();
    expect(normalizeExportRequest({ format: 'godot', scope: 'animation' })).toBeNull();
  });

  it('rejects empty v2 animation and asset scopes', () => {
    expect(normalizeExportRequest({
      version: 2, format: 'phaser', scope: { kind: 'animation', assetId: ASSET_ID, animationIds: [] },
    })).toBeNull();
    expect(normalizeExportRequest({
      version: 2, format: 'phaser', scope: { kind: 'asset', assetIds: [] },
    })).toBeNull();
  });

  it('rejects malformed absolute targets', () => {
    expect(normalizeExportRequest({
      version: 2,
      format: 'phaser',
      scope: { kind: 'approved' },
      target: { kind: 'absolute', path: '../outside' },
    })).toBeNull();
  });
});
