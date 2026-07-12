import type { ExportMeta } from '../atlas-types.js';

export interface PhaserAnimationConfig {
  key: string;
  frames: Array<{ key: string; frame: string; duration?: number }>;
  frameRate: number;
  repeat: number;
  yoyo: boolean;
}

/** Phaser-ready configs consumable with `configs.forEach(c => scene.anims.create(c))`. */
export function buildPhaserAnimations(meta: ExportMeta, atlasKey: string): PhaserAnimationConfig[] {
  return Object.entries(meta.animations ?? {}).map(([key, animation]) => ({
    key,
    frames: animation.frames.map((frame, i) => ({
      key: atlasKey,
      frame,
      ...(animation.durationsMs?.[i] != null ? { duration: animation.durationsMs[i] } : {}),
    })),
    frameRate: animation.fps ?? meta.fps ?? 8,
    repeat: animation.loopMode === 'once' || animation.loop === false ? 0 : -1,
    yoyo: animation.loopMode === 'pingpong',
  }));
}

export function phaserAnimationsText(meta: ExportMeta, atlasKey: string): string {
  return `${JSON.stringify(buildPhaserAnimations(meta, atlasKey), null, 2)}\n`;
}
