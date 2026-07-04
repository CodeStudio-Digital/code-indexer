/**
 * Godot 4 SpriteFrames adapter — emits a `.tres` text resource (format=3)
 * that AnimatedSprite2D consumes directly. One AtlasTexture sub-resource per
 * frame referenced by some animation (deduped by frame index, id suffix IS
 * the frame index); `load_steps` = sub-resource count + 2 (the ext_resource
 * texture + the [resource] itself).
 *
 * Timing: `speed` is the animation fps (meta.fps fallback 8) and `duration`
 * is per-frame in animation-frame units — when `durationsMs[i]` exists it
 * becomes `durationsMs[i] * speed / 1000` rounded to 2 decimals, else 1.0.
 * SpriteFrames has no ping-pong flag, so loopMode 'pingpong' bakes the
 * sequence via expandPingpong and exports `"loop": true`.
 */
import type { AtlasAnimation, ComposedSheet, ExportMeta } from '../atlas-types.js';
import { expandPingpong } from '../gif.js';

interface ResolvedAnim {
  name: string;
  /** Frame index into sheet.rects, per played entry (pingpong already baked). */
  frameIndices: number[];
  /** Per played entry, in Godot animation-frame units. */
  durations: number[];
  loop: boolean;
  speed: number;
}

/** Godot serializes floats with a decimal point (8 → "8.0"). */
function fmt(n: number): string {
  return Number.isInteger(n) ? n.toFixed(1) : String(n);
}

/** Escape a name for a double-quoted .tres string literal. */
function esc(name: string): string {
  return name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function resolveAnim(
  name: string,
  anim: AtlasAnimation,
  nameToIndex: Map<string, number>,
  meta: ExportMeta,
): ResolvedAnim {
  const speed = anim.fps ?? meta.fps ?? 8;
  // Pair index+duration BEFORE filtering so durationsMs stays aligned to frames.
  const entries: Array<{ index: number; duration: number }> = [];
  for (let i = 0; i < anim.frames.length; i++) {
    const index = nameToIndex.get(anim.frames[i]);
    if (index === undefined) continue; // unknown frame name — nothing to point at
    const ms = anim.durationsMs?.[i];
    const duration = ms === undefined ? 1 : Math.round(((ms * speed) / 1000) * 100) / 100;
    entries.push({ index, duration });
  }
  const baked = anim.loopMode === 'pingpong' ? expandPingpong(entries) : entries;
  const loop = anim.loopMode !== undefined ? anim.loopMode !== 'once' : anim.loop !== false;
  return {
    name,
    frameIndices: baked.map((e) => e.index),
    durations: baked.map((e) => e.duration),
    loop,
    speed,
  };
}

/** Serialize one animation dict in Godot's own multi-line .tres layout. */
function animDictText(a: ResolvedAnim): string {
  const frames = a.frameIndices
    .map(
      (idx, i) =>
        `{\n"duration": ${fmt(a.durations[i])},\n"texture": SubResource("AtlasTexture_${idx}")\n}`,
    )
    .join(', ');
  return `{\n"frames": [${frames}],\n"loop": ${a.loop},\n"name": &"${esc(a.name)}",\n"speed": ${fmt(a.speed)}\n}`;
}

/** Serialized Godot 4 SpriteFrames `.tres` resource (trailing newline). */
export function godotTresText(sheet: ComposedSheet, meta: ExportMeta, imageName: string): string {
  const nameToIndex = new Map(sheet.rects.map((r, i) => [r.name, i] as const));
  // No animations in meta → single "default" animation over every frame.
  const source: Record<string, AtlasAnimation> =
    meta.animations && Object.keys(meta.animations).length > 0
      ? meta.animations
      : { default: { frames: sheet.rects.map((r) => r.name) } };
  const anims = Object.entries(source).map(([name, anim]) =>
    resolveAnim(name, anim, nameToIndex, meta),
  );

  // One AtlasTexture per referenced frame index, ascending (dedup across anims).
  const used = [...new Set(anims.flatMap((a) => a.frameIndices))].sort((a, b) => a - b);

  const lines: string[] = [
    `[gd_resource type="SpriteFrames" load_steps=${used.length + 2} format=3]`,
    '',
    `[ext_resource type="Texture2D" path="res://${imageName}" id="1"]`,
    '',
  ];
  for (const i of used) {
    const r = sheet.rects[i];
    lines.push(
      `[sub_resource type="AtlasTexture" id="AtlasTexture_${i}"]`,
      'atlas = ExtResource("1")',
      `region = Rect2(${r.x}, ${r.y}, ${r.w}, ${r.h})`,
      '',
    );
  }
  lines.push('[resource]', `animations = [${anims.map(animDictText).join(', ')}]`);
  return `${lines.join('\n')}\n`;
}
