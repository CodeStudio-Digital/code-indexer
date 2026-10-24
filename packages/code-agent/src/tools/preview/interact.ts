/**
 * Preview interaction tools — drive REAL user input on the agent's preview
 * window over CDP (Input domain): click, type, fill, wait-for-element, key
 * press. Lets agents log in and exercise UI flows (clicks fire React handlers;
 * insertText updates controlled inputs) instead of poking the DOM via eval.
 * Pair with preview_console / preview_network / preview_screenshot to verify.
 */
import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { invokePreview } from './bridge.js';
import { previewFailure } from './failure.js';

async function run(
  ctx: ToolContext,
  method: Parameters<typeof invokePreview>[1],
  args: Record<string, unknown>,
  label: string,
): Promise<ToolResult> {
  try {
    const r = (await invokePreview(ctx, method, args)) as { error?: string };
    if (r && typeof r === 'object' && r.error) return err(r.error);
    return ok(`${label}\n${JSON.stringify(r, null, 2) ?? String(r)}`);
  } catch (e) {
    return previewFailure(e);
  }
}

export const previewClickTool: CoderTool = {
  name: 'preview_click',
  effectBoundary: 'control',
  description:
    'Click an element in the preview page — dispatches a REAL mouse click at its center (fires React/JS handlers, unlike eval). Use to press buttons, links, tabs. Follow with preview_wait_for / preview_screenshot to verify the result.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: { selector: { type: 'string', description: 'Prefer `ref=aN` from preview_snapshot. CSS, `text="visible text"`, and `:has-text("…")` are fallbacks.' } },
    required: ['selector'],
    additionalProperties: false,
  },
  mutates: true,
  parallelSafe: false,
  riskLevel: 'execute',
  repeatable: true,
  handler: (args, ctx) => run(ctx, 'click', { selector: String(args.selector ?? '') }, 'Clicked:'),
};

export const previewFillTool: CoderTool = {
  name: 'preview_fill',
  effectBoundary: 'control',
  description:
    'Fill a form field by snapshot ref or selector — focuses it, selects existing content, and types `value` (real input → controlled React inputs update). Ideal for login/email/password fields. Use preview_press({key:"Enter"}) or preview_click to submit.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'Prefer `ref=aN` from preview_snapshot. CSS or `text="label"` are fallbacks; labels resolve to their form control.' },
      value: { type: 'string', description: 'Text to set as the field value (replaces existing).' },
    },
    required: ['selector', 'value'],
    additionalProperties: false,
  },
  mutates: true,
  parallelSafe: false,
  riskLevel: 'execute',
  handler: (args, ctx) => run(ctx, 'fill', { selector: String(args.selector ?? ''), value: String(args.value ?? '') }, 'Filled:'),
};

export const previewTypeTool: CoderTool = {
  name: 'preview_type',
  effectBoundary: 'control',
  description:
    'Type text at the current caret (or into `selector` if given) — appends rather than replacing. For replacing a field value prefer preview_fill.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to insert at the caret.' },
      selector: { type: 'string', description: 'Optional `ref=aN`, CSS, or `text="label"` to focus before typing.' },
    },
    required: ['text'],
    additionalProperties: false,
  },
  mutates: true,
  parallelSafe: false,
  riskLevel: 'execute',
  handler: (args, ctx) =>
    run(ctx, 'type', { text: String(args.text ?? ''), ...(args.selector ? { selector: String(args.selector) } : {}) }, 'Typed:'),
};

export const previewPressTool: CoderTool = {
  name: 'preview_press',
  effectBoundary: 'control',
  description:
    'Press a keyboard key in the preview: a single character, a named key, or a modifier combo.\n' +
    'Examples: "k", Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, "Meta+k", "Control+a", "Shift+Tab". Optionally focus `selector` first. Use Enter to submit a focused form, or combos for app shortcuts (Cmd/Ctrl+K command palette).',
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'A character, a named key, or a combo like "Meta+k" / "Shift+Tab".' },
      modifiers: { type: 'array', items: { type: 'string' }, description: 'Optional extra modifiers: ctrl, meta, alt, shift, mod (Cmd on macOS else Ctrl).' },
      selector: { type: 'string', description: 'Optional `ref=aN`, CSS, or `text="label"` to focus before the key press.' },
    },
    required: ['key'],
    additionalProperties: false,
  },
  mutates: true,
  parallelSafe: false,
  riskLevel: 'execute',
  repeatable: true,
  handler: (args, ctx) =>
    run(
      ctx,
      'press',
      {
        key: String(args.key ?? ''),
        ...(Array.isArray(args.modifiers) ? { modifiers: args.modifiers } : {}),
        ...(args.selector ? { selector: String(args.selector) } : {}),
      },
      'Pressed:',
    ),
};

export const previewWaitForTool: CoderTool = {
  name: 'preview_wait_for',
  effectBoundary: 'control',
  description:
    'Block until an element matching the selector is present and laid out (e.g. wait for the dashboard after login, or a modal to open). Returns {found:true|false}. Default timeout 5000ms.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: '`ref=aN`, CSS selector, or `text="label"` to wait for.' },
      timeoutMs: { type: 'number', description: 'Max wait in ms (200–30000). Default 5000.' },
    },
    required: ['selector'],
    additionalProperties: false,
  },
  mutates: false,
  parallelSafe: false,
  riskLevel: 'read',
  timeoutMs: 40_000,
  repeatable: true,
  handler: (args, ctx) =>
    run(ctx, 'wait_for', { selector: String(args.selector ?? ''), timeoutMs: args.timeoutMs }, 'Wait:'),
};

export const previewInteractTools: CoderTool[] = [
  previewClickTool,
  previewFillTool,
  previewTypeTool,
  previewPressTool,
  previewWaitForTool,
];
