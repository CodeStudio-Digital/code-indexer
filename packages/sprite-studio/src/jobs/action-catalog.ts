/**
 * Standard action catalog (plan PARTE 1 §1.4, MVP subset) — default frame
 * counts, fps and loop modes for the common game-sprite animations, plus the
 * English motion phrase the frame-pack prompt injects.
 *
 * Consumed by the animation routes (creation defaults) and mirrored BY HAND
 * in the dashboard (`features/sprite-studio/animate/api-anim.ts`
 * ACTION_PRESETS) — the dashboard never imports backend packages, so keep
 * the two lists in sync when editing.
 */

export interface SpriteActionSpec {
  /** Canonical action name — also the default animation row name. */
  action: string;
  /** Default frame count (grid is frames×1 in the frame-pack generation). */
  frames: number;
  fps: number;
  loopMode: 'loop' | 'once' | 'pingpong';
  /** Motion description injected into the frame-pack prompt. */
  phrase: string;
}

export const SPRITE_ACTION_CATALOG: readonly SpriteActionSpec[] = [
  { action: 'idle',   frames: 4, fps: 8,  loopMode: 'loop',
    phrase: 'idle breathing cycle with a subtle up-and-down bob' },
  { action: 'walk',   frames: 6, fps: 8,  loopMode: 'loop',
    phrase: 'walk cycle, legs alternating through contact, down, passing and up poses' },
  { action: 'run',    frames: 6, fps: 10, loopMode: 'loop',
    phrase: 'run cycle with a forward lean and airborne stride' },
  { action: 'attack', frames: 4, fps: 12, loopMode: 'once',
    phrase: 'melee attack: anticipation wind-up, strike, follow-through, recovery' },
  { action: 'hit',    frames: 2, fps: 12, loopMode: 'once',
    phrase: 'taking damage, flinching backwards' },
  { action: 'death',  frames: 6, fps: 8,  loopMode: 'once',
    phrase: 'death animation, staggering and collapsing to the ground' },
  { action: 'jump',   frames: 3, fps: 10, loopMode: 'once',
    phrase: 'jump: crouched anticipation, launch, airborne peak' },
  { action: 'cast',   frames: 4, fps: 10, loopMode: 'once',
    phrase: 'spell cast: gathering energy, raising arms, releasing the spell' },
];

/** Catalog entry for `name`, or undefined for custom actions ('custom:*', …). */
export function actionSpec(name: string): SpriteActionSpec | undefined {
  const key = name.trim().toLowerCase();
  return SPRITE_ACTION_CATALOG.find((a) => a.action === key);
}
