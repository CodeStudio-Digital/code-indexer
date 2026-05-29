/**
 * Renders a plugin-contributed tool window as a SANDBOXED iframe. The HTML is
 * fetched from the plugin dir via `plugins.readAsset` and injected as
 * `srcDoc` with `sandbox="allow-scripts"` (no `allow-same-origin`) — so the
 * frame runs at a null origin with no access to the host DOM, cookies, or
 * storage. Its only channel out is the postMessage bridge (webview-bridge).
 */
import { useEffect, useState } from 'react';
import { ToolWindowFrame } from './ToolWindowFrame.js';
import { apiCall } from '../../../../lib/api-client.js';

interface WebviewWindowProps {
  namespace: string;
  title: string;
  entry: string;
  onClose?: () => void;
}

export function WebviewWindow({ namespace, title, entry, onClose }: WebviewWindowProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <ToolWindowFrame title={title} onClose={onClose}>
      {error ? (
        <div className="p-3 text-sm text-status-error">{error}</div>
      ) : html === null ? (
        <div className="p-3 text-sm text-muted-foreground">Loading…</div>
      ) : (
        <iframe
          title={`plugin:${namespace}:${title}`}
          sandbox="allow-scripts"
          srcDoc={html}
          className="h-full w-full border-0 bg-white"
        />
      )}
    </ToolWindowFrame>
  );
}
