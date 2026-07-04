/**
 * Frame-pack prompt for animation generation (plan §1.3 mitigation (a)):
 * ask the model for ONE image that is a single ROW of n animation frames,
 * sliced locally afterwards. This builds only the INTENT half — the runner
 * appends the compiled style block and the packed-grid suffix itself, so
 * the intent must (1) describe the motion frame-by-frame and (2) explicitly
 * override the grid suffix's "distinct variations" language: cells are
 * consecutive moments of ONE animation, not alternatives.
 */
import { actionSpec } from './action-catalog.js';

/** Compass direction vocabulary (plan §1.4; S = facing the viewer). */
const DIRECTION_PHRASES: Record<string, string> = {
  S: 'facing the viewer (front view)',
  N: 'facing away from the viewer (back view)',
  E: 'facing right',
  W: 'facing left',
  SE: 'facing the lower right (three-quarter front view)',
  SW: 'facing the lower left (three-quarter front view)',
  NE: 'facing the upper right (three-quarter back view)',
  NW: 'facing the upper left (three-quarter back view)',
  side: 'in side view',
};

/** Human phrase for a direction code; undefined for unknown/absent codes. */
export function directionPhrase(direction?: string): string | undefined {
  if (!direction) return undefined;
  return DIRECTION_PHRASES[direction] ?? DIRECTION_PHRASES[direction.toUpperCase()];
}

/**
 * Build the animation intent for `action` ('walk', 'custom:spin', or any
 * free text) across `frames` frames, optionally locked to a direction.
 * Catalog actions contribute their motion phrase; custom ones are used
 * verbatim (minus the 'custom:' prefix).
 */
export function buildAnimationIntent(action: string, frames: number, direction?: string): string {
  const spec = actionSpec(action);
  const motion = spec
    ? spec.phrase
    : action.replace(/^custom:/i, '').trim().replace(/[_-]+/g, ' ') || 'animation';
  const dir = directionPhrase(direction);

  const parts = [
    `sprite sheet: a single row of ${frames} animation frames of the SAME character performing a ${motion}`,
    dir ? `the character is ${dir} in every frame` : null,
    'frame-by-frame progression from the first cell to the last, evenly spaced',
    'each cell is the NEXT moment of the same motion, not an alternative design',
    'the same character with identical colors, outfit and proportions in every frame',
    'only the pose changes between frames',
  ];
  return parts.filter((p): p is string => Boolean(p)).join(', ');
}
