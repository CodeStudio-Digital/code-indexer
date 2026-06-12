/**
 * Renders a plugin-contributed tool window as a SANDBOXED iframe. The HTML is
 * fetched from the plugin dir via `plugins.readAsset`, then we splice in the
 * plugin context (`window.__pluginContext`), the host theme tokens, and the
 * `window.mcp` runtime shim before injecting it as `srcDoc` with
 * `sandbox="allow-scripts"` (no `allow-same-origin`) — null origin, no access
 * to the host DOM/cookies/storage. Its only channel out is the postMessage
 * bridge (webview-bridge), which binds every privileged call to THIS plugin's
 * namespace via the frame registration below.
 *
 * Self-contained (inline title bar) — mounted in ProjectView / BottomPanel /
 * the Company sidebar.
 */
import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { apiCall } from '../../../../lib/api-client.js';
import { injectIntoHtml } from '../../plugin-iframe-runtime.js';
import { currentThemeTokens } from '../../theme-apply.js';
import { registerPluginFrame, unregisterPluginFrame } from '../../webview-bridge.js';
import { useTranslation } from 'react-i18next';

interface WebviewWindowProps {
  namespace: string;
  title: string;
  entry: string;
  /** Scopes the plugin's tool calls (cwd) to a project, when known. */
  projectId?: number;
  onClose?: () => void;
  /** Skip the built-in title bar — for hosts that provide their own chrome
   *  (e.g. the chat right rail wraps the webview in `PanelChrome`). */
  chromeless?: boolean;
}

export function WebviewWindow({
  namespace,
  title,
  entry,
  projectId,
  onClose,
  chromeless = false,
}: WebviewWindowProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // Subscribe so a language switch re-injects + reloads the frame with the new
  // locale (plugins read it via window.mcp.i18n). Uses the app's react-i18next.
  const { i18n, t } = useTranslation('plugins');
  const locale = i18n.language;

  useEffect(() => {
    let alive = true;
    setHtml(null);
    setError(null);
    apiCall<{ content: string }>('plugins.readAsset', { namespace, path: entry })
      .then((r) => alive && setHtml(r.content))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [namespace, entry]);

  // Drop the frame's bridge registration on unmount / reload.
  useEffect(() => {
    return () => {
      const win = iframeRef.current?.contentWindow;
      if (win) unregisterPluginFrame(win);
    };
  }, [html]);

  const doc =
    html === null
      ? null
      : injectIntoHtml(html, { namespace, projectId, locale }, currentThemeTokens());

  return (
    <div className="flex h-full flex-col">
      {!chromeless && (
        <div className="flex h-8 shrink-0 items-center gap-2 border-b bg-card/60 px-3 text-xs">
          <span className="truncate font-medium" title={title}>
            {title}
          </span>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label={t('webview.close')}
              className="ml-auto text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1">
        {error ? (
          <div className="p-3 text-sm text-status-error">{error}</div>
        ) : doc === null ? (
          <div className="p-3 text-sm text-muted-foreground">{t('webview.loading')}</div>
        ) : (
          <iframe
            ref={iframeRef}
            title={`plugin:${namespace}:${title}`}
            sandbox="allow-scripts"
            srcDoc={doc}
            onLoad={() => {
              const win = iframeRef.current?.contentWindow;
              if (win) registerPluginFrame(win, { namespace, projectId });
            }}
            className="h-full w-full border-0"
          />
        )}
      </div>
    </div>
  );
}
