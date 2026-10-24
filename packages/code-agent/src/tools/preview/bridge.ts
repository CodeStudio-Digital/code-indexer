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
import { asAbortSignal } from '@mcp/code-agent/core/abort-signal.js';
import { cancellableToolRpc } from '../cancellable-rpc.js';
import { PreviewOutcomeUnknownError } from './failure.js';
import type { PreviewDispatchScope } from '@mcp/services/preview/contracts.js';
import {
  assertMutationFence,
  MutationFenceError,
} from '@mcp/code-agent/core/mutation-fence.js';

const PREVIEW_EFFECT_METHODS = new Set<PreviewInvoke['method']>([
  'open',
  'close',
  'navigate',
  'viewport',
  'eval',
  'click',
  'type',
  'fill',
  'press',
  'scroll',
  'hover',
  'double_click',
  'right_click',
  'wait_for',
]);

export type { PreviewInvoke, IPreviewDevtools } from './contracts.js';
import type { PreviewInvoke, IPreviewDevtools } from './contracts.js';

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

/** IPC ceiling must be longer than the operation's own timeout. In particular,
 * url-less open may spend 45s booting the dev server before navigation. */
export function previewRpcTimeoutMs(req: PreviewInvoke): number {
  if (req.method === 'open') return 90_000;
  if (req.method === 'navigate') return 35_000;
  if (req.method === 'console') return Math.min(30_000, Math.max(0, Number(req.args?.waitMs) || 0)) + 5_000;
  if (req.method === 'network') return Math.min(30_000, Math.max(0, Number(req.args?.waitForMs) || 0)) + 5_000;
  if (req.method === 'wait_for') return Math.min(30_000, Math.max(200, Number(req.args?.timeoutMs) || 5_000)) + 5_000;
  if (req.method === 'eval') return Math.min(30_000, Math.max(100, Number(req.args?.timeoutMs) || 10_000)) + 5_000;
  return 30_000;
}

/**
 * Stable per-agent window key derived from the tool context, so each agent
 * (coder chat OR company subordinate/master) owns its own preview window(s).
 */
export function previewKey(ctx: ToolContext): string {
  const cc = ctx.companyContext as
    | { agentRunId?: string; companySessionId?: string }
    | undefined;
  if (cc?.agentRunId != null && cc.companySessionId != null) {
    return `company-session-${cc.companySessionId}-agent-${cc.agentRunId}`;
  }
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
  const key = previewKey(ctx);
  const requestId = `preview-${key}-${Date.now().toString(36)}-${(++previewRequestSeq).toString(36)}`;
  const signal = asAbortSignal(ctx.signal);
  if (signal?.aborted) throw new Error('Preview operation aborted.');
  if (PREVIEW_EFFECT_METHODS.has(method)) {
    if (ctx.mutationFence?.mode === 'enforce' && typeof backend.cancel !== 'function') {
      throw new MutationFenceError(
        'unsupported_port',
        `preview.${method} backend does not expose request cancellation`,
      );
    }
    assertMutationFence(ctx.mutationFence, {
      kind: 'control',
      operation: `preview.${method}`,
      resource: key,
    });
  }
  let dispatched = false;
  try {
    return await cancellableToolRpc(
      () => { dispatched = true; return backend.invoke({ key, method, args, requestId }); },
      () => backend.cancel?.(requestId), signal, 'Preview operation aborted.',
    );
  } catch (error) {
    // A transport rejection is not evidence that CDP never delivered a click,
    // keypress, evaluation, navigation or server start. Preserve this ambiguity
    // through the tool result so the runner stops before repeating effects.
    if (dispatched && PREVIEW_EFFECT_METHODS.has(method)) {
      throw new PreviewOutcomeUnknownError(error);
    }
    throw error;
  }
}

let previewRequestSeq = 0;
