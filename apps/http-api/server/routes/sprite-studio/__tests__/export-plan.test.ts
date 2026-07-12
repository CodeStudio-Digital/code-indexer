import { describe, expect, it } from 'vitest';
import { normalizeExportRequest } from '../export-plan.js';

describe('normalizeExportRequest', () => {
  it('keeps v2 animation scope explicit', () => {
    expect(normalizeExportRequest({
      version: 2, format: 'godot',
      scope: { kind: 'animation', assetId: 7, animationIds: [3] },
      target: { kind: 'project', relativeDir: 'assets/sprites' }, options: { trim: true },
    })).toMatchObject({ version: 2, scope: { kind: 'animation', assetId: 7, animationIds: [3] } });
  });

  it('legacy asset export does not silently include animations', () => {
    expect(normalizeExportRequest({ format: 'spritesheet-json', scope: 'asset', assetId: 7, options: {} }))
      .toMatchObject({ scope: { kind: 'asset', assetIds: [7], includeAnimations: false } });
  });

  it('keeps a legacy relative destination project-relative', () => {
    expect(normalizeExportRequest({
      format: 'phaser', scope: 'asset', assetId: 7, destDir: 'game/sprites',
    })?.target).toEqual({ kind: 'project', relativeDir: 'game/sprites' });
  });

  it('rejects unknown formats and incomplete animation bodies', () => {
    expect(normalizeExportRequest({ format: 'zip', scope: 'approved' })).toBeNull();
    expect(normalizeExportRequest({ format: 'godot', scope: 'animation' })).toBeNull();
  });

  it('rejects empty v2 animation and asset scopes', () => {
    expect(normalizeExportRequest({
      version: 2, format: 'phaser', scope: { kind: 'animation', assetId: 8, animationIds: [] },
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
