/**
 * Deterministic teardown of a coder session's agent preview, via the
 * global preview devtools (the real PreviewWindowService in the Electron
 * main process; a no-op when not wired, e.g. headless).
 *
 *   - closePreviewWindow: turn ended → free the BrowserWindow, KEEP any
 *     preview-owned dev server for reuse on the next turn.
 *   - closePreviewSession: session evicted → also stop the owned server.
 *
 * Both are best-effort and never throw into the caller's lifecycle path.
 * Keyed `coder-<sessionId>` to match `previewKey()` for coder sessions.
 */
import { getGlobalPreviewDevtools, type PreviewInvoke } from '@mcp/code-agent/tools/preview/index.js';

function invoke(sessionId: number, method: PreviewInvoke['method']): void {
  const svc = getGlobalPreviewDevtools();
  if (!svc) return;
  try {
    void Promise.resolve(svc.invoke({ key: `coder-${sessionId}`, method })).catch(() => undefined);
  } catch {
    /* preview backend unavailable — nothing to close */
  }
}

export function closePreviewWindow(sessionId: number): void {
  invoke(sessionId, 'closeWindow');
}

export function closePreviewSession(sessionId: number): void {
  invoke(sessionId, 'closeSession');
}
