/**
 * Request assembly + capability routing for the generation stage — split out
 * of job-runner.ts to keep both under the LOC ceiling.
 *
 * Capability policy (plan §2.5): reference images REQUIRE `edit`, a mask
 * REQUIRES `mask` — links that can't satisfy them are skipped, never tried.
 * `background: transparent` only PREFERS native support: incapable links stay
 * in the chain and fall back to the key-color flow (chroma-key background
 * injected into the prompt + a removeBackground op in postprocess).
 */
import type {
  ImageGenCapabilities,
  ImageGenRequest,
  ImageRef,
} from '@mcp/provider-sdk/images.js';
import type { SpriteStyleConfig } from '@mcp/store/sprite-studio/types.js';
import type { SpriteOp } from '../processing/types.js';
import type { ImageChainLink } from './deps.js';

export interface SpriteGenerationJobParams {
  /** What the user/agent asked for ("a goblin chef with a ladle"). */
  intent: string;
  /** Style contract of the sprite project (glue reads it off the project row). */
  style: SpriteStyleConfig;
  /** Candidate count; default 1. n>1 stages variants (no auto version rows). */
  n?: number;
  /** Send `intent` verbatim — skip both expander and deterministic template. */
  rawPrompt?: boolean;
  /** Asset display name, given to the LLM expander for context. */
  assetName?: string;
  /** Base64 reference images → routes to edit-capable links only. */
  referenceImages?: ImageRef[];
  /** Inpaint mask → routes to mask-capable links only. */
  mask?: ImageRef;
  /** Honored by seed-capable backends. */
  seed?: number;
  /** Auto-crop to content before the downscale (postprocess). */
  autoCrop?: boolean;
  /** Extra deterministic ops appended after the style-derived pipeline. */
  extraOps?: SpriteOp[];
  /**
   * Agent path: save candidate 0 as a new version of `job.asset_id` right
   * after postprocess (requires deps.projectRoot). Interactive jobs leave
   * this false and stage candidates instead.
   */
  autoSave?: boolean;
  /**
   * Frame-pack: request ONE grid image with n variants and slice locally
   * (~n× cheaper — image models bill per image). Default ON for n>1 when the
   * deps provide sliceImage. `false` forces n independent generations
   * (maximum diversity, n× the cost).
   */
  packVariants?: boolean;
  /**
   * Explicit packed-grid layout, honored over gridFor(n). Animation
   * frame-packs pass {cols: n, rows: 1} — a single ROW reads as a
   * left-to-right time axis for image models, where gridFor's square-ish
   * fold (4 → 2x2) reads as four alternatives. cols*rows must be ≥ n.
   */
  grid?: { cols: number; rows: number };
}

/** Prompt tail for packed-variant generations (appended AFTER the style block). */
export function buildGridSuffix(cols: number, rows: number, n: number): string {
  return (
    `\n\nCompose exactly a ${cols}x${rows} grid of ${n} DISTINCT variations of this same subject: ` +
    `equal-size cells, one complete subject fully inside each cell, same art style and background ` +
    `in every cell, generous empty spacing between cells, no grid lines, no borders, no labels`
  );
}

/** True when this link can even attempt the request (hard requirements). */
export function linkSatisfies(
  caps: ImageGenCapabilities,
  params: SpriteGenerationJobParams,
): boolean {
  const refs = params.referenceImages?.length ?? 0;
  if (refs > 0 && (!caps.edit || refs > caps.maxReferenceImages)) return false;
  if (params.mask && !caps.mask) return false;
  return true;
}

export interface BuiltRequest {
  req: ImageGenRequest;
  /** Transparent wanted but unsupported → chroma-key + removeBackground op. */
  keyColorFlow: boolean;
  keyColor: string;
}

/** Assemble the provider request for one specific link/capability set. */
export function buildRequest(
  prompt: string,
  negative: string,
  params: SpriteGenerationJobParams,
  caps: ImageGenCapabilities,
  link: ImageChainLink,
): BuiltRequest {
  const style = params.style;
  const cfg = link.config ?? {};
  const keyColor = style.keyColor ?? '#FF00FF';
  const wantsTransparent = style.background === 'transparent';
  const keyColorFlow = wantsTransparent && !caps.transparentBackground;

  const req: ImageGenRequest = {
    prompt: keyColorFlow ? `${prompt}\n\nplain solid ${keyColor} background` : prompt,
    n: params.n ?? 1,
    size:
      typeof cfg.size === 'string'
        ? cfg.size
        : `${style.canvas.workingSize}x${style.canvas.workingSize}`,
  };
  if (wantsTransparent && caps.transparentBackground) req.background = 'transparent';
  const quality = cfg.quality;
  if (quality === 'low' || quality === 'medium' || quality === 'high' || quality === 'auto') {
    req.quality = quality;
  }
  if (caps.negativePrompt && negative) req.negativePrompt = negative;
  if (caps.seed && params.seed !== undefined) req.seed = params.seed;
  if (params.referenceImages?.length) req.referenceImages = params.referenceImages;
  if (params.mask) req.mask = params.mask;
  return { req, keyColorFlow, keyColor };
}

/**
 * Style-derived postprocess pipeline:
 *   [chroma-key sweep (global)] → keepLargestComponent → fitToCanvas(target)
 *   → quantize → outline → hard alpha → caller extras.
 *
 * Framing is the whole game: models leave big margins around the subject (a
 * raw box-downscale of the full canvas buries the character at ~10px) and
 * sometimes emit several subjects. Crop-to-content + aspect-fit + largest-
 * component are therefore ALWAYS on for pixelPerfect styles.
 *
 * Chroma-key uses the GLOBAL sweep (not just border flood): the key color is
 * reserved by contract, and JPEG outputs carry compression noise around it —
 * tolerance 48 + sweep clears interior islands the border flood leaves behind.
 */
export function buildPostOps(
  style: SpriteStyleConfig,
  params: SpriteGenerationJobParams,
  keyColorFlow: boolean,
  keyColor: string,
): SpriteOp[] {
  const ops: SpriteOp[] = [];
  if (keyColorFlow || style.background === 'keyColor') {
    ops.push({ op: 'chromaKeySweep', keyColor, tolerance: 48 });
  }
  if (style.pixelPerfect) {
    ops.push({ op: 'keepLargestComponent' });
    ops.push({
      op: 'fitToCanvas',
      width: style.canvas.width,
      height: style.canvas.height,
      margin: 1,
    });
    if (style.palette.mode === 'fixed' && style.palette.colors?.length) {
      ops.push({ op: 'quantize', colors: style.palette.colors });
    } else if (style.palette.mode === 'maxColors' && style.palette.maxColors) {
      ops.push({ op: 'quantize', maxColors: style.palette.maxColors });
    } else if (Math.max(style.canvas.width, style.canvas.height) <= 64) {
      // 'free' on SMALL canvases still gets a mild reduction (pixel art
      // without a color budget reads as "downscaled photo"). Larger canvases
      // (128/256px hand-painted look) keep full color — a 32-color crush
      // there is visible banding users read as "unfaithful to the reference";
      // quantizing stays available as a manual Adjustments action.
      ops.push({ op: 'quantize', maxColors: 32 });
    }
  } else if (params.autoCrop) {
    ops.push({ op: 'autoCrop' });
  }
  if (style.outline.style !== 'none') {
    const thickness = Math.min(3, Math.max(1, Math.round(style.outline.thickness))) as 1 | 2 | 3;
    // Config carries no outline hex; black is the deterministic enforcement
    // color ('colored'/'selective' nuance is left to the prompt).
    ops.push({ op: 'outline', color: '#000000', thickness });
  }
  if (style.pixelPerfect) ops.push({ op: 'alphaCleanup' });
  return [...ops, ...(params.extraOps ?? [])];
}
