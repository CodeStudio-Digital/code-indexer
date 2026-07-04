import { thresholdAlpha } from './alpha-cleanup.js';
import { autoCrop, centerOnCanvas, placeOnCanvas } from './auto-crop.js';
import { chromaKeySweep, removeBackground } from './background.js';
import { fitToCanvas, keepLargestComponent } from './fit.js';
import { addOutline } from './outline.js';
import { quantizeToPalette } from './quantize.js';
import { boxDownscale, integerScale, nearestNeighborResize } from './resize.js';
import type { RgbaImage, SpriteOp } from './types.js';

/** Apply a single serialized op to an image (pure — input untouched). */
export function applyOp(img: RgbaImage, op: SpriteOp): RgbaImage {
  switch (op.op) {
    case 'quantize':
      return quantizeToPalette(img, {
        colors: op.colors,
        maxColors: op.maxColors,
        dither: op.dither,
      });
    case 'resize': {
      if (op.mode === 'scale') return integerScale(img, op.factor);
      const dims = { width: op.width, height: op.height };
      return op.mode === 'box' ? boxDownscale(img, dims) : nearestNeighborResize(img, dims);
    }
    case 'removeBackground':
      return removeBackground(img, { tolerance: op.tolerance, keyColor: op.keyColor });
    case 'chromaKeySweep':
      return chromaKeySweep(img, { keyColor: op.keyColor, tolerance: op.tolerance });
    case 'keepLargestComponent':
      return keepLargestComponent(img);
    case 'fitToCanvas':
      return fitToCanvas(img, { width: op.width, height: op.height, margin: op.margin, align: op.align });
    case 'outline':
      return addOutline(img, { color: op.color, thickness: op.thickness });
    case 'autoCrop': {
      const cropped = autoCrop(img);
      return op.centerOn ? centerOnCanvas(cropped, op.centerOn) : cropped;
    }
    case 'placeOnCanvas':
      return placeOnCanvas(img, {
        width: op.width, height: op.height, anchorX: op.anchorX, anchorY: op.anchorY,
      });
    case 'alphaCleanup':
      return thresholdAlpha(img, { threshold: op.threshold });
    default: {
      const exhausted: never = op;
      throw new Error(`Unknown sprite op: ${JSON.stringify(exhausted)}`);
    }
  }
}

function describeOp(op: SpriteOp): string {
  switch (op.op) {
    case 'quantize':
      return op.colors?.length ? `quantize to ${op.colors.length}-color palette` : `quantize to ${op.maxColors ?? '?'} colors`;
    case 'resize':
      return op.mode === 'scale' ? `scale x${op.factor}` : `${op.mode} resize to ${op.width}x${op.height}`;
    case 'removeBackground':
      return 'remove background';
    case 'chromaKeySweep':
      return `chroma-key sweep ${op.keyColor}`;
    case 'keepLargestComponent':
      return 'keep largest component';
    case 'fitToCanvas':
      return `fit to ${op.width}x${op.height}`;
    case 'outline':
      return `outline ${op.color} (${op.thickness}px)`;
    case 'autoCrop':
      return op.centerOn ? `auto-crop + center on ${op.centerOn.width}x${op.centerOn.height}` : 'auto-crop';
    case 'placeOnCanvas':
      return `place on ${op.width}x${op.height} (${op.anchorX ?? 'center'}/${op.anchorY ?? 'middle'})`;
    case 'alphaCleanup':
      return 'alpha cleanup';
  }
}

/**
 * Run a serialized op pipeline over an image. `onProgress` fires before each
 * op with its index and a human-readable note.
 */
export function runPipeline(
  img: RgbaImage,
  ops: SpriteOp[],
  onProgress?: (i: number, note: string) => void,
): RgbaImage {
  let current = img;
  for (let i = 0; i < ops.length; i++) {
    onProgress?.(i, describeOp(ops[i]));
    current = applyOp(current, ops[i]);
  }
  return current;
}
