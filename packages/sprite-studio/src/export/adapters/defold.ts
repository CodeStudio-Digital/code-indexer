/**
 * Defold `.atlas` adapter — Defold's atlas is a TEXT resource listing SOURCE
 * images by project-absolute path; the engine packs them itself at build
 * time. So the 'defold' export ships INDIVIDUAL frame PNGs (not a composed
 * sheet) and this file references them as `<imageDir>/<frameName>.png`.
 *
 * Layout rules: frames referenced by an animation appear ONLY inside that
 * animation's `animations {}` block; frames no animation references become
 * top-level `images {}` blocks (single flip-book-less sprites). Defold has
 * native ping-pong playback, so loopMode maps 1:1 — no baking needed.
 * `margin`/`inner_padding` stay 0 (Defold packs the sources itself);
 * `extrude_borders` carries meta.extrude for the same anti-bleeding intent.
 */
import type { AtlasAnimation, ExportMeta } from '../atlas-types.js';

function playbackFor(anim: AtlasAnimation): string {
  const mode = anim.loopMode ?? (anim.loop === false ? 'once' : 'loop');
  if (mode === 'pingpong') return 'PLAYBACK_LOOP_PINGPONG';
  if (mode === 'once') return 'PLAYBACK_ONCE_FORWARD';
  return 'PLAYBACK_LOOP_FORWARD';
}

/**
 * Serialized Defold `.atlas` text (trailing newline). `imageDir` is the
 * project-absolute prefix the frame PNGs live under, e.g.
 * "/assets/sprites/goblin" (trailing slash tolerated).
 */
export function defoldAtlasText(
  frameNames: string[],
  meta: ExportMeta,
  imageDir: string,
): string {
  const dir = imageDir.endsWith('/') ? imageDir.slice(0, -1) : imageDir;
  const img = (name: string): string => `${dir}/${name}.png`;
  const anims = Object.entries(meta.animations ?? {});
  const referenced = new Set(anims.flatMap(([, a]) => a.frames));

  const lines: string[] = [];
  // Orphan frames first (sheet order), as loose top-level images.
  for (const name of frameNames) {
    if (referenced.has(name)) continue;
    lines.push('images {', `  image: "${img(name)}"`, '}');
  }
  for (const [id, anim] of anims) {
    lines.push('animations {', `  id: "${id}"`);
    for (const frame of anim.frames) {
      lines.push('  images {', `    image: "${img(frame)}"`, '  }');
    }
    lines.push(`  playback: ${playbackFor(anim)}`, `  fps: ${anim.fps ?? meta.fps ?? 8}`, '}');
  }
  lines.push('margin: 0', `extrude_borders: ${meta.extrude ?? 0}`, 'inner_padding: 0');
  return `${lines.join('\n')}\n`;
}
