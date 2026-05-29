/**
 * Renders a plugin-contributed tool window as a SANDBOXED iframe. The HTML is
 * fetched from the plugin dir via `plugins.readAsset` and injected as
 * `srcDoc` with `sandbox="allow-scripts"` (no `allow-same-origin`) — so the
 * frame runs at a null origin with no access to the host DOM, cookies, or
 * storage. Its only channel out is the postMessage bridge (webview-bridge).
 *
 * Self-contained (inline title bar) so it doesn't depend on the legacy
 * jetbrains workspace helpers — it's mounted in ProjectView / AgentsTab.
 */
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
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
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b bg-card/60 px-3 text-xs">
        <span className="truncate font-medium" title={title}>
          {title}
        </span>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1">
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
      </div>
    </div>
  );
}
