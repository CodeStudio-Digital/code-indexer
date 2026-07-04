/**
 * Tool registry — one instance per tool id (tools keep their own gesture
 * state in closures, and only one gesture runs at a time).
 */
import { createBrushTool } from './brush-tool.js';
import { createEyedropperTool } from './eyedropper-tool.js';
import { createFillTool } from './fill-tool.js';
import { createMoveTool } from './move-tool.js';
import { createPointerTool } from './pointer-tool.js';
import { createSelectRectTool } from './select-rect-tool.js';
import { createSelectWandTool } from './select-wand-tool.js';
import type { Tool, ToolId } from './tool-types.js';

export const TOOLS: Record<ToolId, Tool> = {
  pointer: createPointerTool(),
  brush: createBrushTool('brush'),
  eraser: createBrushTool('eraser'),
  fill: createFillTool(),
  'select-rect': createSelectRectTool(),
  'select-wand': createSelectWandTool(),
  eyedropper: createEyedropperTool(),
  move: createMoveTool(),
};

export function getTool(id: ToolId): Tool {
  return TOOLS[id];
}
