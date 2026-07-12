/**
 * Export orchestrator (plan §2.7) — pure: takes decoded frames, returns
 * ExportFile[] (PNG bytes + atlas JSON text). The http-api route owns the
 * actual writes into `<repo>/<export_dir>/` and the manifest `exports`
 * block. Universal rules (§1.5): PNG-24 alpha, integer nearest-neighbor
 * scaling, extrude+padding against texture bleeding, rotated:false always.
 */
import { encodePng } from '../processing/png.js';
import { integerScale } from '../processing/resize.js';
import { babylonManifestText } from './adapters/babylon.js';
import { cocosPlistText } from './adapters/cocos-plist.js';
import { defoldAtlasText } from './adapters/defold.js';
import { genericAtlasText } from './adapters/generic-atlas.js';
import { godotTresText } from './adapters/godot-tres.js';
import { phaserAtlasText } from './adapters/phaser.js';
import { phaserAnimationsText } from './adapters/phaser-animations.js';
import { unityImporterText, unityManifestText } from './adapters/unity.js';
import type { ExportFile, ExportMeta } from './atlas-types.js';
import { composeGrid, composePacked, trimNamedFrames, type NamedFrame } from './spritesheet.js';

export type SpriteExportFormat =
  | 'png-individual'
  | 'spritesheet-json'
  | 'phaser'
  | 'unity'
  | 'godot'
  | 'babylon'
  | 'defold'
  | 'cocos';

export interface ExportAssetInput {
  /** Decoded frames in sheet order (frame names become atlas keys / filenames). */
  frames: NamedFrame[];
  format: SpriteExportFormat;
  /** Base name (no extension) for sheet outputs, e.g. 'goblin'. */
  outName: string;
  meta: ExportMeta;
  /** Integer NN scale; overrides meta.scale when given. Default 1. */
  scale?: number;
  /** Grid columns override (default near-square). */
  cols?: number;
  /** Packing strategy and optional alpha trim. */
  packing?: 'grid' | 'packed';
  trim?: boolean;
  /** Defold only: project-absolute dir the frame PNGs live under (default `/assets/<assetSlug>`). */
  defoldImageDir?: string;
}

function scaledFrames(frames: NamedFrame[], scale: number): NamedFrame[] {
  if (scale === 1) return frames;
  return frames.map((f) => ({
    ...f,
    img: integerScale(f.img, scale),
    sourceSize: f.sourceSize ? { w: f.sourceSize.w * scale, h: f.sourceSize.h * scale } : undefined,
    spriteSourceSize: f.spriteSourceSize ? {
      x: f.spriteSourceSize.x * scale, y: f.spriteSourceSize.y * scale,
      w: f.spriteSourceSize.w * scale, h: f.spriteSourceSize.h * scale,
    } : undefined,
  }));
}

function composeSheetFiles(
  frames: NamedFrame[],
  input: ExportAssetInput,
  scale: number,
  atlasText: (sheet: ReturnType<typeof composeGrid>, meta: ExportMeta, image: string) => string,
  atlasExt = 'json',
): ExportFile[] {
  const meta: ExportMeta = { ...input.meta, scale };
  const sheet = input.packing === 'packed'
    ? composePacked(frames, { padding: meta.padding, extrude: meta.extrude })
    : composeGrid(frames, { padding: meta.padding, extrude: meta.extrude, cols: input.cols });
  const imageName = `${input.outName}.png`;
  return [
    { relPath: imageName, bytes: encodePng(sheet.rgba) },
    { relPath: `${input.outName}.${atlasExt}`, text: atlasText(sheet, meta, imageName) },
  ];
}

/**
 * Export one asset's frames as files-in-memory. Formats:
 * - 'png-individual'    → one `<frameName>.png` per frame
 * - 'spritesheet-json'  → `<outName>.png` + sprite-studio-v1 `<outName>.json`
 * - 'phaser' / 'unity'  → `<outName>.png` + TexturePacker-jsonhash `<outName>.json`
 * - 'godot'             → `<outName>.png` + SpriteFrames `<outName>.tres`
 * - 'babylon'           → `<outName>.png` + `<outName>.babylon.json` manifest
 * - 'cocos'             → `<outName>.png` + TexturePacker plist `<outName>.plist`
 * - 'defold'            → one `<frameName>.png` per frame + `<outName>.atlas`
 */
export function exportAsset(input: ExportAssetInput): ExportFile[] {
  if (input.frames.length === 0) throw new Error('exportAsset needs at least one frame');
  const scale = input.scale ?? input.meta.scale ?? 1;
  if (!Number.isInteger(scale) || scale < 1) {
    throw new Error(`Export scale must be a positive integer, got ${String(scale)}`);
  }
  const frames = scaledFrames(input.trim ? trimNamedFrames(input.frames) : input.frames, scale);

  switch (input.format) {
    case 'png-individual':
      return frames.map((f) => ({ relPath: `${f.name}.png`, bytes: encodePng(f.img) }));
    case 'spritesheet-json':
      return composeSheetFiles(frames, input, scale, genericAtlasText);
    case 'phaser': {
      const files = composeSheetFiles(frames, input, scale, phaserAtlasText);
      if (input.meta.animations && Object.keys(input.meta.animations).length > 0) {
        files.push({ relPath: `${input.outName}.animations.json`, text: phaserAnimationsText(input.meta, input.outName) });
      }
      return files;
    }
    case 'unity': {
      const files = composeSheetFiles(frames, input, scale, phaserAtlasText);
      files.push(
        { relPath: `${input.outName}.codesprite.json`, text: unityManifestText(files[1].text ?? '{}', input.meta, `${input.outName}.png`) },
        { relPath: 'Editor/CodeStudioSpriteImporter.cs', text: unityImporterText() },
      );
      return files;
    }
    case 'godot':
      return composeSheetFiles(frames, input, scale, godotTresText, 'tres');
    case 'babylon':
      return composeSheetFiles(frames, input, scale, babylonManifestText, 'babylon.json');
    case 'cocos':
      return composeSheetFiles(frames, input, scale, cocosPlistText, 'plist');
    case 'defold': {
      // Defold packs source images itself: individual frame PNGs + .atlas text.
      const imageDir = input.defoldImageDir ?? `/assets/${input.meta.assetSlug}`;
      const meta: ExportMeta = { ...input.meta, scale };
      return [
        ...frames.map((f) => ({ relPath: `${f.name}.png`, bytes: encodePng(f.img) })),
        {
          relPath: `${input.outName}.atlas`,
          text: defoldAtlasText(frames.map((f) => f.name), meta, imageDir),
        },
      ];
    }
    default: {
      const exhausted: never = input.format;
      throw new Error(`Unknown export format: ${String(exhausted)}`);
    }
  }
}

export * from './atlas-types.js';
export * from './gif.js';
export { composeGrid, composePacked, trimNamedFrames, type ComposeGridParams, type ComposePackedParams, type NamedFrame } from './spritesheet.js';
export { buildGenericAtlas, genericAtlasText, type GenericAtlasJson } from './adapters/generic-atlas.js';
export { buildPhaserAtlas, phaserAtlasText, type PhaserAtlasJson } from './adapters/phaser.js';
export { buildBabylonManifest, babylonManifestText, type BabylonSpriteManifest } from './adapters/babylon.js';
export { cocosPlistText } from './adapters/cocos-plist.js';
export { defoldAtlasText } from './adapters/defold.js';
export { godotTresText } from './adapters/godot-tres.js';
