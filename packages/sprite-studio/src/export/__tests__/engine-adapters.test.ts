import { describe, expect, it } from 'vitest';
import type { RgbaImage } from '../../processing/types.js';
import { babylonManifestText, buildBabylonManifest, type BabylonSpriteManifest } from '../adapters/babylon.js';
import { cocosPlistText } from '../adapters/cocos-plist.js';
import { defoldAtlasText } from '../adapters/defold.js';
import { godotTresText } from '../adapters/godot-tres.js';
import type { AtlasAnimation, ExportMeta } from '../atlas-types.js';
import { exportAsset } from '../index.js';
import { composeGrid } from '../spritesheet.js';

/** Solid-color square frame. */
function solid(size: number, r: number, g: number, b: number): RgbaImage {
  const rgba = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) rgba.set([r, g, b, 255], i * 4);
  return { rgba, width: size, height: size };
}

const frames = [
  { name: 'goblin_idle_000', img: solid(4, 255, 0, 0) },
  { name: 'goblin_idle_001', img: solid(4, 0, 255, 0) },
  { name: 'goblin_idle_002', img: solid(4, 0, 0, 255) },
];
const names = frames.map((f) => f.name);
// cols = ceil(sqrt(3)) = 2 → rects at (3,3), (11,3), (3,11), each 4x4.
const sheet = composeGrid(frames, { padding: 2, extrude: 1 });

const baseMeta: ExportMeta = {
  assetSlug: 'goblin', scale: 1, padding: 2, extrude: 1, pivot: { x: 0.5, y: 1 }, fps: 8,
};
const withAnim = (anim: Partial<AtlasAnimation>): ExportMeta => ({
  ...baseMeta,
  animations: { idle: { frames: names, fps: 8, ...anim } },
});

describe('godot .tres adapter (SpriteFrames)', () => {
  it('emits one AtlasTexture per referenced frame with load_steps = subs + 2', () => {
    const text = godotTresText(sheet, withAnim({ loop: true }), 'goblin.png');
    expect(text).toContain('load_steps=5 format=3');
    expect(text).toContain('[ext_resource type="Texture2D" path="res://goblin.png" id="1"]');
    expect(text).toContain('region = Rect2(3, 3, 4, 4)');
    expect(text).toContain('region = Rect2(11, 3, 4, 4)');
    expect(text).toContain('region = Rect2(3, 11, 4, 4)');
    expect(text).toContain('"name": &"idle"');
    expect(text).toContain('"speed": 8.0');
    expect(text).toContain('"loop": true');
  });

  it('bakes pingpong ([a,b,c] plays as a,b,c,b) without duplicating sub-resources', () => {
    const text = godotTresText(sheet, withAnim({ loopMode: 'pingpong' }), 'goblin.png');
    expect(text.match(/SubResource\("AtlasTexture_/g)).toHaveLength(4);
    expect(text.match(/\[sub_resource /g)).toHaveLength(3); // deduped by frame index
    expect(text).toContain('load_steps=5');
    expect(text).toContain('"loop": true');
  });

  it("loopMode 'once' exports loop false", () => {
    const text = godotTresText(sheet, withAnim({ loopMode: 'once' }), 'goblin.png');
    expect(text).toContain('"loop": false');
  });

  it('converts durationsMs to frame units against the animation speed', () => {
    // 250ms at 8fps = 2 animation frames; 125ms = 1.
    const text = godotTresText(sheet, withAnim({ durationsMs: [250, 125, 125] }), 'goblin.png');
    expect(text).toContain('"duration": 2.0');
    expect(text).toContain('"duration": 1.0');
  });

  it('falls back to a "default" animation over all frames when meta has none', () => {
    const single = composeGrid([frames[0]], {});
    const noFps: ExportMeta = {
      assetSlug: 'goblin', scale: 1, padding: 0, extrude: 0, pivot: { x: 0.5, y: 1 },
    };
    expect(godotTresText(single, noFps, 'goblin.png')).toBe(
      `[gd_resource type="SpriteFrames" load_steps=3 format=3]

[ext_resource type="Texture2D" path="res://goblin.png" id="1"]

[sub_resource type="AtlasTexture" id="AtlasTexture_0"]
atlas = ExtResource("1")
region = Rect2(0, 0, 4, 4)

[resource]
animations = [{
"frames": [{
"duration": 1.0,
"texture": SubResource("AtlasTexture_0")
}],
"loop": true,
"name": &"default",
"speed": 8.0
}]
`,
    );
  });
});

describe('babylon manifest adapter (babylon-sprite-v1)', () => {
  it('emits parseable JSON with cell size, frame count and min/max frame range', () => {
    const parsed = JSON.parse(
      babylonManifestText(sheet, withAnim({ loop: true }), 'goblin.png'),
    ) as BabylonSpriteManifest;
    expect(parsed.meta).toEqual({
      app: 'CodeStudio Sprite Studio', format: 'babylon-sprite-v1', image: 'goblin.png',
    });
    expect(parsed.cellWidth).toBe(4);
    expect(parsed.cellHeight).toBe(4);
    expect(parsed.frameCount).toBe(3);
    expect(parsed.animations['idle']).toEqual({ from: 0, to: 2, fps: 8, loop: true, delayMs: 125 });
  });

  it("maps 'once' to loop:false and durationsMs[0] to delayMs", () => {
    const m = buildBabylonManifest(
      sheet, withAnim({ loopMode: 'once', durationsMs: [90, 90, 90] }), 'goblin.png',
    );
    expect(m.animations['idle']).toMatchObject({ loop: false, delayMs: 90 });
  });

  it("pingpong exports as loop:true (playAnimation limitation)", () => {
    const m = buildBabylonManifest(sheet, withAnim({ loopMode: 'pingpong' }), 'goblin.png');
    expect(m.animations['idle'].loop).toBe(true);
  });
});

describe('defold .atlas adapter', () => {
  const dir = '/assets/sprites/goblin';

  it('groups animation frames in their block and orphans as loose images', () => {
    const meta = { ...baseMeta, animations: { idle: { frames: [names[0], names[1]], fps: 8 } } };
    const text = defoldAtlasText(names, meta, dir);
    // Orphan (frame 2) is a top-level images block, before the animations.
    expect(text).toContain(`images {\n  image: "${dir}/goblin_idle_002.png"\n}`);
    expect(text.indexOf('goblin_idle_002.png')).toBeLessThan(text.indexOf('animations {'));
    // Animation frames appear ONLY inside the animation block (4-space indent).
    expect(text).toContain(`  images {\n    image: "${dir}/goblin_idle_000.png"\n  }`);
    expect(text.match(/goblin_idle_000\.png/g)).toHaveLength(1);
    expect(text).toContain('  id: "idle"');
    expect(text).toContain('  playback: PLAYBACK_LOOP_FORWARD');
    expect(text).toContain('  fps: 8');
    expect(text).toContain('margin: 0');
    expect(text).toContain('extrude_borders: 1');
    expect(text).toContain('inner_padding: 0');
  });

  it('maps loopMode to Defold playback modes', () => {
    expect(defoldAtlasText(names, withAnim({ loopMode: 'pingpong' }), dir))
      .toContain('playback: PLAYBACK_LOOP_PINGPONG');
    expect(defoldAtlasText(names, withAnim({ loopMode: 'once' }), dir))
      .toContain('playback: PLAYBACK_ONCE_FORWARD');
    expect(defoldAtlasText(names, withAnim({ loop: false }), dir)) // legacy bool compat
      .toContain('playback: PLAYBACK_ONCE_FORWARD');
  });
});

describe('cocos plist adapter (TexturePacker format 2)', () => {
  it('emits well-formed plist XML with frame rects and metadata', () => {
    const text = cocosPlistText(sheet, baseMeta, 'goblin.png');
    expect(text).toContain('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"');
    expect(text).toContain('<key>format</key><integer>2</integer>');
    expect(text).toContain('<key>goblin_idle_000.png</key>');
    expect(text).toContain('<key>frame</key><string>{{3,3},{4,4}}</string>');
    expect(text).toContain('<key>frame</key><string>{{11,3},{4,4}}</string>');
    expect(text).toContain('<key>rotated</key><false/>');
    expect(text).toContain('<key>textureFileName</key><string>goblin.png</string>');
    expect(text).toContain('<key>size</key><string>{18,18}</string>');
    expect(text.match(/<dict>/g)).toHaveLength(text.match(/<\/dict>/g)?.length ?? -1);
  });

  it('XML-escapes frame names', () => {
    const weird = composeGrid([{ name: 'sword & <shield>', img: solid(4, 1, 2, 3) }], {});
    const text = cocosPlistText(weird, baseMeta, 'goblin.png');
    expect(text).toContain('<key>sword &amp; &lt;shield&gt;.png</key>');
    expect(text).not.toContain('sword & <shield>');
  });
});

describe('determinism', () => {
  it('same input produces byte-identical text for every adapter', () => {
    const meta = withAnim({ loopMode: 'pingpong', durationsMs: [100, 100, 100] });
    expect(godotTresText(sheet, meta, 'g.png')).toBe(godotTresText(sheet, meta, 'g.png'));
    expect(babylonManifestText(sheet, meta, 'g.png')).toBe(babylonManifestText(sheet, meta, 'g.png'));
    expect(defoldAtlasText(names, meta, '/a/b')).toBe(defoldAtlasText(names, meta, '/a/b'));
    expect(cocosPlistText(sheet, meta, 'g.png')).toBe(cocosPlistText(sheet, meta, 'g.png'));
  });
});

describe('exportAsset engine formats', () => {
  it("'unity' aliases the phaser builder into <outName>.json", () => {
    const unity = exportAsset({ frames, format: 'unity', outName: 'goblin', meta: baseMeta });
    const phaser = exportAsset({ frames, format: 'phaser', outName: 'goblin', meta: baseMeta });
    expect(unity.map((f) => f.relPath)).toEqual(['goblin.png', 'goblin.json']);
    expect(unity[1].text).toBe(phaser[1].text);
  });

  it("'godot'/'babylon'/'cocos' write sheet PNG + engine atlas text", () => {
    const rel = (fmt: 'godot' | 'babylon' | 'cocos'): string[] =>
      exportAsset({ frames, format: fmt, outName: 'goblin', meta: baseMeta }).map((f) => f.relPath);
    expect(rel('godot')).toEqual(['goblin.png', 'goblin.tres']);
    expect(rel('babylon')).toEqual(['goblin.png', 'goblin.babylon.json']);
    expect(rel('cocos')).toEqual(['goblin.png', 'goblin.plist']);
  });

  it("'defold' writes individual frame PNGs + .atlas with the default image dir", () => {
    const files = exportAsset({ frames, format: 'defold', outName: 'goblin', meta: baseMeta });
    expect(files.map((f) => f.relPath)).toEqual([
      'goblin_idle_000.png', 'goblin_idle_001.png', 'goblin_idle_002.png', 'goblin.atlas',
    ]);
    expect(files[3].text).toContain('image: "/assets/goblin/goblin_idle_000.png"');
  });

  it("'defold' honors defoldImageDir", () => {
    const files = exportAsset({
      frames, format: 'defold', outName: 'goblin', meta: baseMeta, defoldImageDir: '/gfx/goblin/',
    });
    expect(files[3].text).toContain('image: "/gfx/goblin/goblin_idle_000.png"');
  });
});
