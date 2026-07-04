/**
 * Deterministic prompt compiler — consistency layer A (plan PARTE 1 §1.3).
 *
 * The style block is compiled from the project's SpriteStyleConfig and
 * appended to every generation prompt, so the "style contract" reaches the
 * model even when no LLM prompt-expander is bound (or when it throws). The
 * exact compiled text is snapshotted on each version for reproducibility.
 */
import type { SpriteStyleConfig } from '@mcp/store/sprite-studio/types.js';

/** Always-on tail — single subject FILLING the frame (models default to tiny
 *  subjects with huge margins, which downscale into a handful of pixels),
 *  clean of text/watermarks. */
export const STYLE_SUFFIX =
  'exactly one subject, centered, full body visible, the subject fills most of the frame, ' +
  'no text, no watermark';

/** Reference-mode tail — identity/style come from the IMAGE, not from prose. */
export const REFERENCE_SUFFIX =
  'match the art style, color palette and character identity of the reference image(s) exactly, ' +
  'the SAME character, ' + STYLE_SUFFIX;

const DEFAULT_NEGATIVE =
  'blurry, photorealistic, 3d render, extra limbs, text, watermark, multiple characters';

/** Hard cap on the compiled style block (~150 words per plan §1.3). */
const WORD_CAP = 150;

function paletteFragment(palette: SpriteStyleConfig['palette']): string | null {
  if (palette.mode === 'fixed' && palette.colors?.length) {
    return `strict color palette: ${palette.colors.join(', ')}`;
  }
  if (palette.mode === 'maxColors' && palette.maxColors) {
    return `limited palette of ${palette.maxColors} colors`;
  }
  return null; // 'free' — no constraint
}

function outlineFragment(outline: SpriteStyleConfig['outline']): string {
  if (outline.style === 'none') return 'no outline';
  if (outline.style === 'selective') return 'selective outline';
  return `${outline.style} outline (${outline.thickness}px)`;
}

/**
 * Background policy: keyColor → solid chroma-key bg (backends without alpha,
 * removed in postprocess); transparent → native alpha + isolation hints;
 * scene → no constraint (the sprite is meant to live in a scene).
 */
function backgroundFragment(style: SpriteStyleConfig): string | null {
  if (style.background === 'keyColor') {
    return `plain solid ${style.keyColor ?? '#FF00FF'} background`;
  }
  if (style.background === 'transparent') {
    return 'transparent background, isolated on plain background, no scene';
  }
  return null;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export interface CompileStyleOpts {
  /**
   * Reference images accompany the request: SLIM the block. Identity, palette,
   * lighting, proportions etc. come from the IMAGE — restating them as prose
   * makes the model drift away from the reference (the exact failure users see
   * vs. the Gemini/ChatGPT web UIs, which send only intent + image).
   */
  hasReferences?: boolean;
}

/** Compile the deterministic STYLE block (≤ ~150 words, keywords trimmed first). */
export function compileStyleBlock(style: SpriteStyleConfig, opts: CompileStyleOpts = {}): string {
  const { width, height } = style.canvas;
  const canvasLine = style.pixelPerfect
    ? `pixel art game sprite on a ${width}x${height} pixel grid`
    : `2D game sprite for a ${width}x${height} canvas`;

  if (opts.hasReferences) {
    // Reference mode: technical framing + background policy ONLY.
    const base = [canvasLine, backgroundFragment(style)].filter((f): f is string => Boolean(f));
    base.push(REFERENCE_SUFFIX);
    return base.join(', ');
  }

  const fixed: Array<string | null> = [
    canvasLine,
    `${style.perspective} view`,
    paletteFragment(style.palette),
    `lit from ${style.light}`,
    `${style.shading} shading`,
    outlineFragment(style.outline),
    `${style.proportions} proportions`,
    `${style.detailLevel} detail`,
    backgroundFragment(style),
  ];
  const base = fixed.filter((f): f is string => Boolean(f));

  // Free-form keywords only get whatever word budget the contract leaves over.
  const budget = WORD_CAP - countWords(base.join(', ')) - countWords(STYLE_SUFFIX);
  const keywords = style.styleKeywords.trim();
  if (keywords && budget > 0) {
    const words = keywords.split(/\s+/).filter(Boolean);
    base.push(words.slice(0, budget).join(' '));
  }
  base.push(STYLE_SUFFIX);
  return base.join(', ');
}

/** intent + blank line + compiled style block — the no-LLM fallback prompt. */
export function buildFinalPrompt(
  intent: string,
  style: SpriteStyleConfig,
  opts: CompileStyleOpts = {},
): string {
  return `${intent.trim()}\n\n${compileStyleBlock(style, opts)}`;
}

/** Negative prompt: project negativeKeywords first, then defaults (deduped). */
export function buildNegative(style: SpriteStyleConfig): string {
  const custom = style.negativeKeywords.split(',').map((t) => t.trim()).filter(Boolean);
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const term of [...custom, ...DEFAULT_NEGATIVE.split(', ')]) {
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return terms.join(', ');
}
