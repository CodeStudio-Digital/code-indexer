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
]);

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
    | 'closeWindowPrefix'
    | 'closeSessionPrefix'
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
    | 'snapshot'
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
  /** Correlates cancellation across worker -> host. */
  requestId?: string;
}

export interface IPreviewDevtools {
  invoke(req: PreviewInvoke): Promise<unknown>;
  /** Best-effort cancellation for long-running open/wait/eval operations. */
  cancel?(requestId: string): void | Promise<void>;
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
  if (ctx.signal?.aborted) throw new Error('Preview operation aborted.');
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
  const pending = backend.invoke({ key, method, args, requestId });
  if (!ctx.signal) return pending;
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      ctx.signal!.removeEventListener('abort', onAbort);
      void Promise.resolve(backend.cancel?.(requestId)).catch(() => undefined);
      reject(new Error('Preview operation aborted.'));
    };
    ctx.signal!.addEventListener('abort', onAbort, { once: true });
    if (ctx.signal!.aborted) onAbort();
    pending.then(
      (value) => {
        ctx.signal!.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        ctx.signal!.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

let previewRequestSeq = 0;
