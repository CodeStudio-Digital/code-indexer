/**
 * Preview DevTools bridge — the process-singleton the `preview_*` tools call,
 * mirroring `setGlobalDocSearch` (rag-search-docs.ts).
 *
 * The REAL implementation is a `PreviewWindowService` in the Electron main
 * process (opens a dedicated BrowserWindow per agent + attaches the Chrome
 * DevTools Protocol). In the coder/company WORKER, a shim is installed that
 * forwards `invoke` over the worker→host MessageBridge (`previewDevtools`).
 * In headless / non-Electron runs nothing is wired → tools degrade.
 */
import type { ToolContext } from '@mcp/code-agent/core/tool.js';

/** A single agent→devtools request. `key` scopes the window per agent. */
export interface PreviewInvoke {
  key: string;
  method:
    | 'open'
    | 'close'
    // Lifecycle (backend-triggered, not agent-facing): closeWindow frees the
    // BrowserWindow at turn end but keeps any preview-owned dev server alive
    // for reuse; closeSession also stops the owned server (session evict).
    | 'closeWindow'
    | 'closeSession'
    | 'navigate'
    | 'viewport'
    | 'console'
    | 'network'
    | 'eval'
    | 'screenshot'
    | 'inspect_css'
    | 'performance'
    | 'memory'
    | 'storage'
    | 'click'
    | 'type'
    | 'fill'
    | 'wait_for'
    | 'press'
    | 'scroll'
    | 'hover'
    | 'double_click'
    | 'right_click'
    // Backend-only: offscreen screenshot of a URL (no agent window needed).
    // Used by builder checkpoints for timeline thumbnails.
    | 'thumbnail';
  args?: Record<string, unknown>;
}

export interface IPreviewDevtools {
  invoke(req: PreviewInvoke): Promise<unknown>;
}

let globalPreview: IPreviewDevtools | null = null;

/** Wire the singleton. Electron main sets the real service; the worker sets a
 *  bridge shim; headless leaves it null. Pass null to detach (tests). */
export function setGlobalPreviewDevtools(impl: IPreviewDevtools | null): void {
  globalPreview = impl;
}
export function getGlobalPreviewDevtools(): IPreviewDevtools | null {
  return globalPreview;
}

export const PREVIEW_UNAVAILABLE =
  'Preview DevTools are unavailable here. They only work in the desktop app — ask the user to run the MCP IDE desktop build, then open a dev server.';

/**
 * Stable per-agent window key derived from the tool context, so each agent
 * (coder chat OR company subordinate/master) owns its own preview window(s).
 */
export function previewKey(ctx: ToolContext): string {
  const cc = ctx.companyContext as
    | { agentRunId?: number; companySessionId?: number }
    | undefined;
  if (cc?.agentRunId != null) return `company-agent-${cc.agentRunId}`;
  if (cc?.companySessionId != null) return `company-session-${cc.companySessionId}`;
  return `coder-${ctx.sessionId ?? 'main'}`;
}

/** Shared invoke helper for the tools — returns the typed result or throws a
 *  friendly "unavailable" so the tool handler can surface it as an error. */
export async function invokePreview(
  ctx: ToolContext,
  method: PreviewInvoke['method'],
  args?: Record<string, unknown>,
): Promise<unknown> {
  const backend = getGlobalPreviewDevtools();
  if (!backend) throw new Error(PREVIEW_UNAVAILABLE);
  return backend.invoke({ key: previewKey(ctx), method, args });
}
