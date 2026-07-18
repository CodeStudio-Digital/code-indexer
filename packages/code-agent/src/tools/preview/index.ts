/**
 * Preview DevTools tool group — agent-driven, isolated preview window + CDP.
 * Lives in the dedicated `preview` tool tier (see tools/tiers.ts), activated
 * when the preview backend is available (the desktop app).
 */
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import { previewOpenTool, previewNavigateTool, previewCloseTool, previewViewportTool } from './control.js';
import {
  previewConsoleTool,
  previewNetworkTool,
  previewEvalTool,
  previewScreenshotTool,
  previewInspectCssTool,
  previewPerformanceTool,
  previewMemoryTool,
  previewStorageTool,
  previewSnapshotTool,
} from './inspect.js';
import { previewInteractTools } from './interact.js';
import { previewExtraInteractTools } from './interact-extra.js';

export { setGlobalPreviewDevtools, getGlobalPreviewDevtools, previewRpcTimeoutMs } from './bridge.js';
export type { IPreviewDevtools, PreviewInvoke } from './bridge.js';

export const previewTools: CoderTool[] = [
  previewOpenTool,
  previewNavigateTool,
  previewViewportTool,
  previewCloseTool,
  previewConsoleTool,
  previewNetworkTool,
  previewEvalTool,
  previewScreenshotTool,
  previewInspectCssTool,
  previewPerformanceTool,
  previewMemoryTool,
  previewStorageTool,
  previewSnapshotTool,
  ...previewInteractTools,
  ...previewExtraInteractTools,
];

/** Tool names — used by tiers.ts to put them in the `preview` tier. */
export const PREVIEW_TOOL_NAMES = previewTools.map((t) => t.name);
