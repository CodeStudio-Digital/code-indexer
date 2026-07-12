/**
 * Tool registry — one instance per tool id (tools keep their own gesture
 * state in closures, and only one gesture runs at a time). GHOST_TOOLS /
 * PAINT_TOOLS are the behavior sets EditorCanvas keys off: which tools show
 * the size ghost, and which accept the Alt = temporary-eyedropper gesture.
 */
import { createBrushTool } from './brush-tool.js';
import { createEyedropperTool } from './eyedropper-tool.js';
import { createFillTool } from './fill-tool.js';
import { createMoveTool } from './move-tool.js';
import { createPointerTool } from './pointer-tool.js';
import { createSelectRectTool } from './select-rect-tool.js';
import { createSelectWandTool } from './select-wand-tool.js';
import { createSelectLassoTool } from './select-lasso-tool.js';
import { createShapeTool } from './shape-tools.js';
import type { Tool, ToolId } from './tool-types.js';

export const TOOLS: Record<ToolId, Tool> = {
  pointer: createPointerTool(),
  brush: createBrushTool('brush'),
  pencil: createBrushTool('pencil'),
  eraser: createBrushTool('eraser'),
  'magic-eraser': createFillTool('magic-eraser'),
  fill: createFillTool('fill'),
  line: createShapeTool('line'),
  'shape-rect': createShapeTool('rect'),
  'shape-ellipse': createShapeTool('ellipse'),
  'select-rect': createSelectRectTool(),
  'select-wand': createSelectWandTool(),
  'select-lasso': createSelectLassoTool(),
  eyedropper: createEyedropperTool(),
  move: createMoveTool(),
};

export function getTool(id: ToolId): Tool {
  return TOOLS[id];
}

/** Tools whose cursor shows the size ghost (stroke thickness at the cursor). */
export const GHOST_TOOLS: ReadonlySet<ToolId> = new Set<ToolId>([
  'brush', 'pencil', 'eraser', 'line', 'shape-rect', 'shape-ellipse',
]);

/** Paint-family tools where Alt-at-pointer-down means temporary eyedropper
 *  (never the select tools — alt = subtract there). */
export const PAINT_TOOLS: ReadonlySet<ToolId> = new Set<ToolId>([
  'brush', 'pencil', 'eraser', 'magic-eraser', 'fill', 'line', 'shape-rect', 'shape-ellipse',
]);
