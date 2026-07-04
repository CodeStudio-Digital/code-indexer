/**
 * Export orchestrator (plan §2.7) — pure: takes decoded frames, returns
 * ExportFile[] (PNG bytes + atlas JSON text). The http-api route owns the
 * actual writes into `<repo>/<export_dir>/` and the manifest `exports`
 * block. Universal rules (§1.5): PNG-24 alpha, integer nearest-neighbor
 * scaling, extrude+padding against texture bleeding, rotated:false always.
 */
import { encodePng } from '../processing/png.js';
import { integerScale } from '../processing/resize.js';
import { genericAtlasText } from './adapters/generic-atlas.js';
import { phaserAtlasText } from './adapters/phaser.js';
import type { ExportFile, ExportMeta } from './atlas-types.js';
import { composeGrid, type NamedFrame } from './spritesheet.js';

export type SpriteExportFormat = 'png-individual' | 'spritesheet-json' | 'phaser';

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
}

function scaledFrames(frames: NamedFrame[], scale: number): NamedFrame[] {
  if (scale === 1) return frames;
  return frames.map((f) => ({ name: f.name, img: integerScale(f.img, scale) }));
}

function composeSheetFiles(
  frames: NamedFrame[],
  input: ExportAssetInput,
  scale: number,
  atlasText: (sheet: ReturnType<typeof composeGrid>, meta: ExportMeta, image: string) => string,
): ExportFile[] {
  const meta: ExportMeta = { ...input.meta, scale };
  const sheet = composeGrid(frames, {
    padding: meta.padding,
    extrude: meta.extrude,
    cols: input.cols,
  });
  const imageName = `${input.outName}.png`;
  return [
    { relPath: imageName, bytes: encodePng(sheet.rgba) },
    { relPath: `${input.outName}.json`, text: atlasText(sheet, meta, imageName) },
  ];
}

/**
 * Export one asset's frames as files-in-memory. Formats:
 * - 'png-individual'    → one `<frameName>.png` per frame
 * - 'spritesheet-json'  → `<outName>.png` + sprite-studio-v1 `<outName>.json`
 * - 'phaser'            → `<outName>.png` + TexturePacker-jsonhash `<outName>.json`
 */
export function exportAsset(input: ExportAssetInput): ExportFile[] {
  if (input.frames.length === 0) throw new Error('exportAsset needs at least one frame');
  const scale = input.scale ?? input.meta.scale ?? 1;
  if (!Number.isInteger(scale) || scale < 1) {
    throw new Error(`Export scale must be a positive integer, got ${String(scale)}`);
  }
  const frames = scaledFrames(input.frames, scale);

  switch (input.format) {
    case 'png-individual':
      return frames.map((f) => ({ relPath: `${f.name}.png`, bytes: encodePng(f.img) }));
    case 'spritesheet-json':
      return composeSheetFiles(frames, input, scale, genericAtlasText);
    case 'phaser':
      return composeSheetFiles(frames, input, scale, phaserAtlasText);
    default: {
      const exhausted: never = input.format;
      throw new Error(`Unknown export format: ${String(exhausted)}`);
    }
  }
}

export * from './atlas-types.js';
export * from './gif.js';
export { composeGrid, type ComposeGridParams, type NamedFrame } from './spritesheet.js';
export { buildGenericAtlas, genericAtlasText, type GenericAtlasJson } from './adapters/generic-atlas.js';
export { buildPhaserAtlas, phaserAtlasText, type PhaserAtlasJson } from './adapters/phaser.js';
