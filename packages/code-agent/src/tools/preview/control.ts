/**
 * Preview window lifecycle tools — open / close / navigate the agent's
 * dedicated DevTools-attached preview window.
 */
import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { invokePreview } from './bridge.js';

export const previewOpenTool: CoderTool = {
  name: 'preview_open',
  description:
    'Open a DEDICATED preview window for the running app with DevTools (CDP) attached.\n' +
    'Lets you read its console/network, run JS, and screenshot it — a clean, isolated page (no interference).\n' +
    'PREFER calling it with NO url: we attach to THIS project\'s dev server — reusing the one already running, or starting one for you — and shut it down at the end. Do NOT run `npm run dev` yourself in the shell.\n' +
    'Pass `url` (loopback, e.g. http://localhost:5173) only for a special case (a server we cannot detect). If a window is already open for this session it is reused/navigated.\n' +
    'USE before preview_console/network/eval/screenshot. The window is yours for this session and is closed automatically when the run ends.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Optional. Loopback dev-server URL (e.g. http://localhost:5173). Omit to auto-attach to the project dev server (reuse the running one or start it).',
      },
      preset: {
        type: 'string',
        enum: ['desktop', 'hd', 'fullhd', 'laptop', 'tablet', 'mobile'],
        description: 'Optional initial viewport preset (default hd 1366×768). Change later with preview_viewport.',
      },
      width: { type: 'number', description: 'Optional initial viewport width (px); overrides preset.' },
      height: { type: 'number', description: 'Optional initial viewport height (px); overrides preset.' },
    },
    additionalProperties: false,
  },
  mutates: false,
  parallelSafe: false,
  riskLevel: 'execute',
  // Idempotent — reuses/navigates the existing window; re-ensuring it is fine.
  repeatable: true,
  handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const url = String(args.url ?? '').trim();
    // With a url it must be loopback; without one we resolve via the project's
    // runner (needs ctx.projectId, which coder sessions always carry).
    if (url && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(url)) {
      return err('url must be a loopback dev-server URL (http://localhost:PORT).');
    }
    if (!url && ctx.projectId == null) {
      return err('No project context to auto-detect the dev server — pass an explicit loopback url.');
    }
    try {
      const r = (await invokePreview(ctx, 'open', {
        ...(url ? { url } : { projectId: ctx.projectId }),
        ...(args.preset ? { preset: args.preset } : {}),
        ...(args.width != null ? { width: args.width } : {}),
        ...(args.height != null ? { height: args.height } : {}),
      })) as { windowId?: number; url?: string; viewport?: { width: number; height: number }; reused?: boolean };
      const vp = r.viewport ? ` at ${r.viewport.width}×${r.viewport.height}` : '';
      const how = r.reused === false ? ' (started a dev server — it stops when the session ends)' : r.reused ? ' (reusing the running dev server)' : '';
      return ok(`Preview window ready for ${r.url ?? url} (id ${r.windowId ?? '?'})${vp}${how}. Use preview_console / preview_network / preview_screenshot to inspect it; preview_viewport to change size.`);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

export const previewNavigateTool: CoderTool = {
  name: 'preview_navigate',
  description: 'Navigate the session preview window to a new loopback URL (same window, fresh page).',
  source: 'native',
  parameters: {
    type: 'object',
    properties: { url: { type: 'string', description: 'Loopback URL to navigate to.' } },
    required: ['url'],
    additionalProperties: false,
  },
  mutates: false,
  parallelSafe: false,
  riskLevel: 'execute',
  // Re-navigating the same URL is a legit refresh, not a loop.
  repeatable: true,
  handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const url = String(args.url ?? '').trim();
    if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(url)) {
      return err('url must be a loopback dev-server URL.');
    }
    try {
      await invokePreview(ctx, 'navigate', { url });
      return ok(`Navigated preview to ${url}.`);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

export const previewViewportTool: CoderTool = {
  name: 'preview_viewport',
  description:
    'Resize the preview window to a target viewport for responsive debugging — screenshots and layout then reflect this size. Use a `preset` (mobile/tablet/desktop/laptop/hd/fullhd) or custom width/height; WIDTH-based breakpoints react (mobile nav, stacking, overflow). Note: resizes the real window (clamped to your screen); it does not emulate touch or a mobile user-agent yet, so sites that switch purely on UA/touch may not.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      preset: {
        type: 'string',
        enum: ['desktop', 'hd', 'fullhd', 'laptop', 'tablet', 'mobile'],
        description: 'Named size: mobile 390×844 · tablet 768×1024 · desktop 1280×800 · hd 1366×768 · laptop 1440×900 · fullhd 1920×1080.',
      },
      width: { type: 'number', description: 'Custom viewport width (px); overrides preset.' },
      height: { type: 'number', description: 'Custom viewport height (px); overrides preset.' },
      deviceScaleFactor: { type: 'number', description: 'Informational pixel density (1 = normal). Reserved.' },
      mobile: { type: 'boolean', description: 'Hint that this is a mobile size (width still drives the layout).' },
    },
    additionalProperties: false,
  },
  mutates: false,
  parallelSafe: false,
  riskLevel: 'read',
  repeatable: true,
  handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
    try {
      const r = (await invokePreview(ctx, 'viewport', {
        ...(args.preset ? { preset: args.preset } : {}),
        ...(args.width != null ? { width: args.width } : {}),
        ...(args.height != null ? { height: args.height } : {}),
        ...(args.deviceScaleFactor != null ? { deviceScaleFactor: args.deviceScaleFactor } : {}),
        ...(args.mobile != null ? { mobile: args.mobile } : {}),
      })) as { viewport?: { width: number; height: number; deviceScaleFactor: number; mobile: boolean } };
      const v = r.viewport;
      return ok(v ? `Viewport set to ${v.width}×${v.height} (dpr ${v.deviceScaleFactor}${v.mobile ? ', mobile' : ''}).` : 'Viewport updated.');
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

export const previewCloseTool: CoderTool = {
  name: 'preview_close',
  description: "Close this session's preview window(s) and detach DevTools. Frees the window process.",
  source: 'native',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  mutates: false,
  parallelSafe: false,
  riskLevel: 'execute',
  handler: async (_args, ctx: ToolContext): Promise<ToolResult> => {
    try {
      await invokePreview(ctx, 'close');
      return ok('Preview window closed.');
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};
