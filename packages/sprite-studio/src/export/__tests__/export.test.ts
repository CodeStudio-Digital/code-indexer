import { describe, expect, it } from 'vitest';
import { decodePng } from '../../processing/png.js';
import type { RgbaImage } from '../../processing/types.js';
import { buildGenericAtlas } from '../adapters/generic-atlas.js';
import { buildPhaserAtlas } from '../adapters/phaser.js';
import type { ExportMeta } from '../atlas-types.js';
import { exportAsset } from '../index.js';
import { composeGrid, composePacked, trimNamedFrames } from '../spritesheet.js';

/** Solid-color square frame. */
function solid(size: number, r: number, g: number, b: number): RgbaImage {
  const rgba = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) rgba.set([r, g, b, 255], i * 4);
  return { rgba, width: size, height: size };
}

const frames = [
  { name: 'goblin_idle_S_000', img: solid(4, 255, 0, 0) },
  { name: 'goblin_idle_S_001', img: solid(4, 0, 255, 0) },
];

const meta: ExportMeta = {
  assetSlug: 'goblin',
  scale: 1,
  padding: 2,
  extrude: 1,
  pivot: { x: 0.5, y: 1 },
};

describe('composeGrid', () => {
  it('lays out 2 4x4 frames with padding 2 / extrude 1 on an 18x10 sheet', () => {
    const sheet = composeGrid(frames, { padding: 2, extrude: 1 });
    // block = 4 + 2*1 = 6; sheet = pad + cols*(block+pad) = 2 + 2*8 = 18 x 2 + 1*8 = 10
    expect(sheet.rgba.width).toBe(18);
    expect(sheet.rgba.height).toBe(10);
    expect(sheet.rects).toEqual([
      expect.objectContaining({ name: 'goblin_idle_S_000', x: 3, y: 3, w: 4, h: 4 }),
      expect.objectContaining({ name: 'goblin_idle_S_001', x: 11, y: 3, w: 4, h: 4 }),
    ]);
  });

  it('extrudes cell edge pixels outward (anti-bleeding ring)', () => {
    const sheet = composeGrid(frames, { padding: 2, extrude: 1 });
    const px = (x: number, y: number): number[] => {
      const i = (y * sheet.rgba.width + x) * 4;
      return Array.from(sheet.rgba.rgba.slice(i, i + 4));
    };
    expect(px(3, 3)).toEqual([255, 0, 0, 255]); // frame 0 top-left pixel
    expect(px(2, 3)).toEqual([255, 0, 0, 255]); // left extrude column duplicates it
    expect(px(2, 2)).toEqual([255, 0, 0, 255]); // corner extrude
    expect(px(1, 3)).toEqual([0, 0, 0, 0]); // padding stays transparent
    expect(px(10, 3)).toEqual([0, 255, 0, 255]); // frame 1 left extrude (green)
  });

  it('rejects empty frame lists', () => {
    expect(() => composeGrid([], {})).toThrow(/at least one frame/);
  });
});

describe('trim + packed sheet', () => {
  it('trims transparent margins and preserves source metadata', () => {
    const rgba = new Uint8Array(4 * 4 * 4);
    rgba.set([255, 0, 0, 255], (1 * 4 + 2) * 4);
    const [trimmed] = trimNamedFrames([{ name: 'one', img: { rgba, width: 4, height: 4 } }]);
    expect([trimmed.img.width, trimmed.img.height]).toEqual([1, 1]);
    expect(trimmed.sourceSize).toEqual({ w: 4, h: 4 });
    expect(trimmed.spriteSourceSize).toEqual({ x: 2, y: 1, w: 1, h: 1 });
    const packed = composePacked([trimmed], { padding: 1, extrude: 1 });
    expect(packed.rects[0]).toMatchObject({ trimmed: true, sourceSize: { w: 4, h: 4 } });
  });
});

describe('generic atlas adapter (sprite-studio-v1)', () => {
  it('emits meta/frameSize/pivot/frames', () => {
    const sheet = composeGrid(frames, { padding: 2, extrude: 1 });
    const atlas = buildGenericAtlas(sheet, meta, 'goblin.png');
    expect(atlas.meta).toMatchObject({
      format: 'sprite-studio-v1', image: 'goblin.png', size: { w: 18, h: 10 }, scale: 1,
    });
    expect(atlas.frameSize).toEqual({ w: 4, h: 4 });
    expect(atlas.pivot).toEqual({ x: 0.5, y: 1 });
    expect(atlas.frames).toHaveLength(2);
    expect(atlas.frames[1]).toEqual({ name: 'goblin_idle_S_001', x: 11, y: 3, w: 4, h: 4 });
    expect(atlas.animations).toBeUndefined();
  });

  it('carries animations when present in meta', () => {
    const sheet = composeGrid(frames, {});
    const atlas = buildGenericAtlas(
      sheet,
      { ...meta, animations: { idle_S: { frames: frames.map((f) => f.name), fps: 8, loop: true } } },
      'goblin.png',
    );
    expect(atlas.animations?.idle_S).toMatchObject({ fps: 8, loop: true });
  });
});

describe('phaser adapter (TexturePacker jsonhash)', () => {
  it('emits frames keyed by name with rotated:false and pivot', () => {
    const sheet = composeGrid(frames, { padding: 2, extrude: 1 });
    const atlas = buildPhaserAtlas(sheet, meta, 'goblin.png');
    const f = atlas.frames['goblin_idle_S_000'];
    expect(f).toMatchObject({
      frame: { x: 3, y: 3, w: 4, h: 4 },
      rotated: false,
      trimmed: false,
      sourceSize: { w: 4, h: 4 },
      spriteSourceSize: { x: 0, y: 0, w: 4, h: 4 },
      pivot: { x: 0.5, y: 1 },
    });
    expect(atlas.meta).toMatchObject({ image: 'goblin.png', format: 'RGBA8888', scale: '1' });
  });
});

describe('exportAsset', () => {
  it('png-individual: one scaled PNG per frame', () => {
    const files = exportAsset({ frames, format: 'png-individual', outName: 'goblin', meta, scale: 2 });
    expect(files.map((f) => f.relPath)).toEqual(['goblin_idle_S_000.png', 'goblin_idle_S_001.png']);
    const img = decodePng(files[0].bytes as Buffer);
    expect([img.width, img.height]).toEqual([8, 8]); // 4x4 at integer scale 2
  });

  it('spritesheet-json: sheet PNG + sprite-studio-v1 JSON', () => {
    const files = exportAsset({ frames, format: 'spritesheet-json', outName: 'goblin', meta });
    expect(files.map((f) => f.relPath)).toEqual(['goblin.png', 'goblin.json']);
    const img = decodePng(files[0].bytes as Buffer);
    expect([img.width, img.height]).toEqual([18, 10]);
    const json = JSON.parse(files[1].text as string) as { meta: { format: string } };
    expect(json.meta.format).toBe('sprite-studio-v1');
  });

  it('phaser: sheet PNG + jsonhash atlas honoring scale', () => {
    const files = exportAsset({ frames, format: 'phaser', outName: 'goblin', meta, scale: 2 });
    const json = JSON.parse(files[1].text as string) as {
      frames: Record<string, { frame: { w: number } }>; meta: { scale: string };
    };
    expect(json.meta.scale).toBe('2');
    expect(json.frames['goblin_idle_S_000'].frame.w).toBe(8); // frames scaled before packing
  });

  it('phaser emits ready-to-register animation configs', () => {
    const animated = { ...meta, animations: { walk: { frames: frames.map((f) => f.name), fps: 8, loopMode: 'pingpong' as const } } };
    const files = exportAsset({ frames, format: 'phaser', outName: 'goblin', meta: animated });
    expect(files.map((file) => file.relPath)).toContain('goblin.animations.json');
    const configs = JSON.parse(files.find((file) => file.relPath.endsWith('.animations.json'))?.text ?? '[]') as Array<{ key: string; yoyo: boolean }>;
    expect(configs).toEqual([expect.objectContaining({ key: 'walk', yoyo: true })]);
  });

  it('rejects non-integer scales', () => {
    expect(() => exportAsset({ frames, format: 'phaser', outName: 'g', meta, scale: 1.5 })).toThrow(/integer/);
  });
});
