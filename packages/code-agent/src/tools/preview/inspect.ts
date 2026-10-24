/**
 * Preview DevTools inspection tools — read console/network, eval JS, capture
 * a screenshot (vision), inspect CSS, and read performance/memory/storage —
 * all over CDP on the agent's dedicated preview window. Work in any project
 * (chat or company) once `preview_open` has run.
 */
import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import type { ImageBlock } from '@mcp/code-agent/core/messages.js';
import { invokePreview } from './bridge.js';
import { previewFailure } from './failure.js';

function fmt(label: string, result: unknown): ToolResult {
  if (result && typeof result === 'object' && typeof (result as { error?: unknown }).error === 'string') {
    return err((result as { error: string }).error);
  }
  const serialized = JSON.stringify(result, null, 2) ?? String(result);
  const sourceTruncations = result && typeof result === 'object'
    && Array.isArray((result as { sourceTruncations?: unknown }).sourceTruncations)
    ? (result as { sourceTruncations: NonNullable<ToolResult['sourceTruncations']> }).sourceTruncations
    : undefined;
  // Keep the raw inspector payload intact. The runner owns reversible shaping
  // and can spill oversized results before applying its context-relative cap.
  return {
    content: `${label}\n${serialized}`,
    contentFormat: 'text',
    structuredData: result,
    ...(sourceTruncations?.length ? { sourceTruncations } : {}),
  };
}
async function run(
  ctx: ToolContext,
  method: Parameters<typeof invokePreview>[1],
  args: Record<string, unknown>,
  label: string,
): Promise<ToolResult> {
  try {
    return fmt(label, await invokePreview(ctx, method, args));
  } catch (e) {
    return previewFailure(e);
  }
}

export const previewConsoleTool: CoderTool = {
  name: 'preview_console',
  effectBoundary: 'control',
  description:
    'Read the preview page console — logs, warnings, errors, and uncaught exceptions (real-time). Pass `waitMs` to BLOCK until new output arrives (e.g. after triggering an action), or omit for a snapshot of recent output.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      level: { type: 'string', enum: ['all', 'error', 'warn'], description: 'Filter by level. Default all.' },
      waitMs: { type: 'number', description: 'Block up to N ms for the NEXT console entry (active wait). Omit for snapshot.' },
      limit: { type: 'number', description: 'Recent console entries to return (default 50, max 250).' },
    },
    additionalProperties: false,
  },
  mutates: false,
  parallelSafe: false,
  riskLevel: 'read',
  timeoutMs: 40_000,
  // Page state evolves between identical calls — re-reading the console after
  // an action is the workflow, not a loop. Exempt from the dedup guard (the
  // polling soft/hard caps still brake a genuinely stuck poll).
  repeatable: true,
  handler: (args, ctx) => run(ctx, 'console', { level: args.level, waitMs: args.waitMs, limit: args.limit }, 'Console:'),
};

export const previewNetworkTool: CoderTool = {
  name: 'preview_network',
  effectBoundary: 'control',
  description:
    'Read the preview page network activity — requests/responses with method, URL, status, and timing. Filter by `urlFilter`/`status` to validate endpoint calls (e.g. find 4xx/5xx). `waitForMs` blocks until a matching request completes (active wait). `includeBody` adds response bodies (truncated).',
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      urlFilter: { type: 'string', description: 'Substring to match request URLs.' },
      status: { type: 'number', description: 'Match a specific HTTP status (e.g. 500). Or 0 for any >=400.' },
      includeBody: { type: 'boolean', description: 'Include (truncated) response bodies.' },
      bodyMaxChars: { type: 'number', description: 'Per-response text-body ceiling (default 20000, max 200000). Omissions are reported and can be retried with a larger value.' },
      bodyTotalMaxChars: { type: 'number', description: 'Aggregate body ceiling for this call (default 200000, max 2000000).' },
      limit: { type: 'number', description: 'Recent matching requests to return (default 60, max 250).' },
      waitForMs: { type: 'number', description: 'Block up to N ms for the next matching request to finish.' },
    },
    additionalProperties: false,
  },
  mutates: false,
  parallelSafe: false,
  riskLevel: 'read',
  timeoutMs: 40_000,
  repeatable: true,
  handler: (args, ctx) =>
    run(ctx, 'network', {
      urlFilter: args.urlFilter,
      status: args.status,
      includeBody: args.includeBody,
      bodyMaxChars: args.bodyMaxChars,
      bodyTotalMaxChars: args.bodyTotalMaxChars,
      limit: args.limit,
      waitForMs: args.waitForMs,
    }, 'Network:'),
};

export const previewEvalTool: CoderTool = {
  name: 'preview_eval',
  effectBoundary: 'control',
  description:
    'Run JavaScript in the preview page context and return the result (Runtime.evaluate). Use for service/endpoint calls with the app\'s own cookies/origin (e.g. `await fetch("/api/me").then(r=>r.status)`), reading state, or driving the UI.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      js: { type: 'string', description: 'JS expression to evaluate (async supported; the last expression is the result).' },
      timeoutMs: { type: 'number', description: 'Execution timeout in ms (default 10000, max 30000).' },
    },
    required: ['js'],
    additionalProperties: false,
  },
  mutates: true,
  parallelSafe: false,
  riskLevel: 'execute',
  repeatable: true,
  timeoutMs: 40_000,
  handler: (args, ctx) => run(ctx, 'eval', { js: String(args.js ?? ''), timeoutMs: args.timeoutMs }, 'Eval result:'),
};

export const previewScreenshotTool: CoderTool = {
  name: 'preview_screenshot',
  effectBoundary: 'control',
  description:
    'Capture a screenshot of the preview page — the image becomes visible to you (vision) on the next turn. Use to SEE the rendered UI. ' +
    'If your model can\'t see images, set `lookFor` to what you need (e.g. "any layout/alignment bugs" or "describe the screen to verify it matches the spec") — a vision model translates the screenshot to text for you.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      fullPage: { type: 'boolean', description: 'Capture the full scrollable page (default viewport only).' },
      lookFor: {
        type: 'string',
        description:
          'Optional. What to look for / how to describe the screenshot if your model can\'t see images (vision fallback). Task-specific, e.g. "evaluate alignment & overflow" or "describe the layout".',
      },
    },
    additionalProperties: false,
  },
  mutates: false,
  parallelSafe: false,
  riskLevel: 'read',
  timeoutMs: 40_000,
  repeatable: true,
  handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
    try {
      const r = (await invokePreview(ctx, 'screenshot', { fullPage: !!args.fullPage })) as { base64?: string };
      if (!r.base64) return err('screenshot returned no image.');
      const describeHint = typeof args.lookFor === 'string' && args.lookFor.trim() ? args.lookFor.trim() : undefined;
      const block: ImageBlock = { type: 'image', mediaType: 'image/png', base64: r.base64, describeHint };
      const kb = Math.max(1, Math.round((r.base64.length * 3) / 4 / 1024));
      return {
        content: `Captured the preview (PNG, ~${kb} KB). The screenshot is visible to you next turn.`,
        extraUserBlocks: [block],
      };
    } catch (e) {
      return previewFailure(e);
    }
  },
};

export const previewInspectCssTool: CoderTool = {
  name: 'preview_inspect_css',
  effectBoundary: 'control',
  description: 'Inspect computed + matched CSS rules for the first element matching a selector (debug layout/styling).',
  source: 'native',
  parameters: {
    type: 'object',
    properties: { selector: { type: 'string', description: 'CSS selector (first match).' } },
    required: ['selector'],
    additionalProperties: false,
  },
  mutates: false,
  parallelSafe: false,
  riskLevel: 'read',
  repeatable: true,
  handler: (args, ctx) => run(ctx, 'inspect_css', { selector: String(args.selector ?? '') }, 'CSS:'),
};

export const previewPerformanceTool: CoderTool = {
  name: 'preview_performance',
  effectBoundary: 'control',
  description: 'Read page performance metrics (Performance.getMetrics + navigation timing) — load time, layout, script duration, etc.',
  source: 'native',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  mutates: false,
  parallelSafe: false,
  riskLevel: 'read',
  repeatable: true,
  handler: (_args, ctx) => run(ctx, 'performance', {}, 'Performance:'),
};

export const previewMemoryTool: CoderTool = {
  name: 'preview_memory',
  effectBoundary: 'control',
  description: 'Read the page JS heap usage (used/total/limit) to spot leaks or bloat.',
  source: 'native',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  mutates: false,
  parallelSafe: false,
  riskLevel: 'read',
  repeatable: true,
  handler: (_args, ctx) => run(ctx, 'memory', {}, 'Memory:'),
};

export const previewStorageTool: CoderTool = {
  name: 'preview_storage',
  effectBoundary: 'control',
  description: 'Read application storage: localStorage, sessionStorage, cookies, or IndexedDB names. Pass `kind`.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: { kind: { type: 'string', enum: ['local', 'session', 'cookies', 'indexeddb'], description: 'Which store to read. Default local.' } },
    additionalProperties: false,
  },
  mutates: false,
  parallelSafe: false,
  riskLevel: 'read',
  repeatable: true,
  handler: (args, ctx) => run(ctx, 'storage', { kind: args.kind ?? 'local' }, 'Storage:'),
};

export const previewSnapshotTool: CoderTool = {
  name: 'preview_snapshot',
  effectBoundary: 'control',
  description:
    'Read a compact accessibility snapshot of the current page with stable refs such as `ref=a12`. ' +
    'Use this before interacting: refs target the exact accessible element and are more reliable than invented CSS selectors. ' +
    'Refs become stale after navigation; call preview_snapshot again when the page changes.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      interactiveOnly: { type: 'boolean', description: 'Only return actionable controls. Default false also includes headings, dialogs, alerts, and named landmarks.' },
      maxDepth: { type: 'number', description: 'Maximum accessibility-tree depth (default 12, max 40).' },
      limit: { type: 'number', description: 'Maximum nodes (default 200, max 500).' },
    },
    additionalProperties: false,
  },
  mutates: false,
  parallelSafe: false,
  riskLevel: 'read',
  repeatable: true,
  handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
    try {
      const result = (await invokePreview(ctx, 'snapshot', {
        interactiveOnly: args.interactiveOnly,
        maxDepth: args.maxDepth,
        limit: args.limit,
      })) as {
        page?: { url?: string; title?: string; navigationId?: number };
        nodes?: Array<{ ref: string; depth: number; role: string; name: string; value?: string; states?: Record<string, unknown> }>;
        sourceTruncations?: NonNullable<ToolResult['sourceTruncations']>;
      };
      const page = result.page;
      const lines = [
        `Page: ${page?.title || '(untitled)'} — ${page?.url || '(unknown URL)'} (navigation ${page?.navigationId ?? 0})`,
        ...(result.nodes ?? []).map((node) => {
          const indent = '  '.repeat(Math.min(node.depth, 12));
          const name = node.name ? ` ${JSON.stringify(node.name)}` : '';
          const value = node.value != null ? ` value=${JSON.stringify(node.value)}` : '';
          const states = node.states && Object.keys(node.states).length ? ` ${JSON.stringify(node.states)}` : '';
          return `${indent}[ref=${node.ref}] ${node.role}${name}${value}${states}`;
        }),
      ];
      return {
        content: lines.join('\n'),
        contentFormat: 'text',
        structuredData: result,
        ...(result.sourceTruncations?.length ? { sourceTruncations: result.sourceTruncations } : {}),
      };
    } catch (error) {
      return previewFailure(error);
    }
  },
};
