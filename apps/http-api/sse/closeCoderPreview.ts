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
import { getGlobalResearchBrowser } from '@mcp/code-agent/tools/browser/index.js';

function invoke(sessionId: number, method: PreviewInvoke['method']): void {
  const svc = getGlobalPreviewDevtools();
  if (!svc) return;
  try {
    void Promise.resolve(svc.invoke({ key: `coder-${sessionId}`, method })).catch(() => undefined);
  } catch {
    /* preview backend unavailable — nothing to close */
  }
}

function invokeKey(key: string, method: PreviewInvoke['method']): void {
  const svc = getGlobalPreviewDevtools();
  if (!svc) return;
  try {
    void Promise.resolve(svc.invoke({ key, method })).catch(() => undefined);
  } catch {
    /* preview backend unavailable — nothing to close */
  }
}

export function closePreviewWindow(sessionId: number): void {
  invoke(sessionId, 'closeWindow');
  void getGlobalResearchBrowser()?.invoke({ key: `coder-${sessionId}`, method: 'close' }).catch(() => undefined);
}

export function closePreviewSession(sessionId: number): void {
  invoke(sessionId, 'closeSession');
  void getGlobalResearchBrowser()?.invoke({ key: `coder-${sessionId}`, method: 'close' }).catch(() => undefined);
}

export function closeCompanyPreviewWindows(sessionId: number): void {
  invokeKey(`company-session-${sessionId}`, 'closeWindowPrefix');
  void getGlobalResearchBrowser()?.invoke({ key: `company-session-${sessionId}`, method: 'closePrefix' }).catch(() => undefined);
}

export function closeCompanyPreviewSession(sessionId: number): void {
  invokeKey(`company-session-${sessionId}`, 'closeSessionPrefix');
  void getGlobalResearchBrowser()?.invoke({ key: `company-session-${sessionId}`, method: 'closePrefix' }).catch(() => undefined);
}
