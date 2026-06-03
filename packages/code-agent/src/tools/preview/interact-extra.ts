/**
 * Extra preview interaction tools — scroll, hover, double-click, right-click.
 * Same CDP Input backing + `text="..."`/CSS targeting as the core interact
 * tools (interact.ts). Split into its own file to stay under the LOC cap.
 */
import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { invokePreview } from './bridge.js';

async function run(
  ctx: ToolContext,
  method: Parameters<typeof invokePreview>[1],
  args: Record<string, unknown>,
  label: string,
): Promise<ToolResult> {
  try {
    const r = (await invokePreview(ctx, method, args)) as { error?: string };
    if (r && typeof r === 'object' && r.error) return err(r.error);
    return ok(`${label}\n${JSON.stringify(r, null, 2).slice(0, 2000)}`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

const SELECTOR_DESC = 'A CSS selector OR `text="visible text"` (e.g. `text="Settings"`).';

export const previewScrollTool: CoderTool = {
  name: 'preview_scroll',
  description:
    'Scroll the preview page. Pass `selector` to scroll that element into view (center), or `x`/`y` deltas to scroll the window (e.g. y:600 = down). Use for long pages / lazy-loaded content before screenshot/click.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: `Optional. ${SELECTOR_DESC} Scrolls it into view.` },
      x: { type: 'number', description: 'Horizontal scroll delta in px (window scroll; ignored if selector given).' },
      y: { type: 'number', description: 'Vertical scroll delta in px (positive = down).' },
    },
    additionalProperties: false,
  },
  mutates: false,
  parallelSafe: false,
  riskLevel: 'read',
  repeatable: true,
  handler: (args, ctx) =>
    run(
      ctx,
      'scroll',
      {
        ...(args.selector ? { selector: String(args.selector) } : {}),
        ...(args.x != null ? { x: args.x } : {}),
        ...(args.y != null ? { y: args.y } : {}),
      },
      'Scrolled:',
    ),
};

export const previewHoverTool: CoderTool = {
  name: 'preview_hover',
  description:
    'Move the mouse over an element (real mouseover/mouseenter) — opens hover menus, tooltips, and reveals on-hover controls. Follow with preview_screenshot or preview_click.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: { selector: { type: 'string', description: SELECTOR_DESC } },
    required: ['selector'],
    additionalProperties: false,
  },
  mutates: false,
  parallelSafe: false,
  riskLevel: 'read',
  repeatable: true,
  handler: (args, ctx) => run(ctx, 'hover', { selector: String(args.selector ?? '') }, 'Hovered:'),
};

export const previewDoubleClickTool: CoderTool = {
  name: 'preview_double_click',
  description: 'Double-click an element (real mouse, clickCount 2) — e.g. enter inline edit, select a word, open an item.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: { selector: { type: 'string', description: SELECTOR_DESC } },
    required: ['selector'],
    additionalProperties: false,
  },
  mutates: false,
  parallelSafe: false,
  riskLevel: 'execute',
  handler: (args, ctx) => run(ctx, 'double_click', { selector: String(args.selector ?? '') }, 'Double-clicked:'),
};

export const previewRightClickTool: CoderTool = {
  name: 'preview_right_click',
  description: 'Right-click an element (real mouse) — opens the context menu. Follow with preview_click on a menu item (by text).',
  source: 'native',
  parameters: {
    type: 'object',
    properties: { selector: { type: 'string', description: SELECTOR_DESC } },
    required: ['selector'],
    additionalProperties: false,
  },
  mutates: false,
  parallelSafe: false,
  riskLevel: 'execute',
  handler: (args, ctx) => run(ctx, 'right_click', { selector: String(args.selector ?? '') }, 'Right-clicked:'),
};

export const previewExtraInteractTools: CoderTool[] = [
  previewScrollTool,
  previewHoverTool,
  previewDoubleClickTool,
  previewRightClickTool,
];
