/**
 * Eyedropper: sample the FLATTENED composite (what the user sees, not the
 * active layer) and report the hex through ctx.pickColor. The composite is
 * flattened once per gesture, not per move event.
 */
import { rgbaToHex } from '../algorithms/image-data.js';
import type { Tool, ToolContext, ToolPointerEvent } from './tool-types.js';

export function createEyedropperTool(): Tool {
  let composite: ImageData | null = null;

  const sample = (e: ToolPointerEvent, ctx: ToolContext) => {
    if (!composite) composite = ctx.doc.flatten();
    const x = Math.floor(e.imageX);
    const y = Math.floor(e.imageY);
    if (x < 0 || y < 0 || x >= composite.width || y >= composite.height) return;
    const i = (y * composite.width + x) * 4;
    if (composite.data[i + 3] === 0) return; // ignore fully transparent
    ctx.pickColor(rgbaToHex(composite.data[i], composite.data[i + 1], composite.data[i + 2]));
  };

  return {
    id: 'eyedropper',
    cursor: 'crosshair',
    onDown: sample,
    onMove(e, ctx) {
      if (e.buttons & 1) sample(e, ctx);
    },
    onUp() {
      composite = null; // re-flatten next gesture
    },
  };
}
