/**
 * Non-modal consent banner: "Install PHP support (Intelephense, ~25 MB)?"
 * Shown over the editor when the active file's language has a tier-1 LSP
 * server that isn't installed yet. Freemium contract: downloads happen
 * ONLY from the button here (or the admin panel) — never automatically.
 * "Not now" snoozes per language (localStorage).
 */
import { useEffect, useRef, useState } from 'react';
import { Download, Loader2, X } from 'lucide-react';
import { apiCall, apiStream, electronApi } from '../../../lib/api-client.js';
import { languageIdForPath } from '@mcp/shared/utils/language-id.js';

interface ServerStatusDTO {
  state: 'no-server' | 'not-installed' | 'starting' | 'ready' | 'failed' | 'disabled';
  server?: { id: string; label: string; version: string; sizeLabel: string };
  autoPrompt?: boolean;
}
type InstallFrame =
  | { phase: 'start' }
  | { phase: 'log'; line: string }
  | { phase: 'done' }
  | { phase: 'error'; message: string };

const SNOOZE_KEY = 'mcp-ide:lsp-install-snooze';

function snoozed(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(SNOOZE_KEY) ?? '{}') as Record<string, boolean>; } catch { return {}; }
}
function snooze(lang: string): void {
  localStorage.setItem(SNOOZE_KEY, JSON.stringify({ ...snoozed(), [lang]: true }));
}

export function LspInstallPrompt({ projectId, filePath }: { projectId: number; filePath: string }) {
  const language = languageIdForPath(filePath);
  const [status, setStatus] = useState<ServerStatusDTO | null>(null);
  const [installing, setInstalling] = useState(false);
  const [lastLog, setLastLog] = useState('');
  const [error, setError] = useState<string | null>(null);
  const dismissed = useRef(false);

  useEffect(() => {
    dismissed.current = false;
    setStatus(null);
    setError(null);
    if (language === 'plaintext' || language === 'typescript' || language === 'javascript') return;
    if (snoozed()[language]) return;
    let cancelled = false;
    void apiCall<ServerStatusDTO>('lsp.serverStatus', { projectId, languageId: language })
      .then((s) => { if (!cancelled) setStatus(s); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [projectId, language]);

  if (!status || status.state !== 'not-installed' || !status.server || dismissed.current) return null;
  if (status.autoPrompt === false) return null; // admin turned the banner off
  const server = status.server;

  const install = async (): Promise<void> => {
    setInstalling(true);
    setError(null);
    try {
      if (electronApi()) {
        for await (const frame of apiStream<InstallFrame>('lsp.installServerStream', { serverId: server.id })) {
          if (frame.phase === 'log') setLastLog(frame.line);
          if (frame.phase === 'error') throw new Error(frame.message);
          if (frame.phase === 'done') break;
        }
      } else {
        await new Promise<void>((resolve, reject) => {
          const es = new EventSource(`/api/lsp/servers/${server.id}/install/stream`);
          es.addEventListener('install', (ev) => {
            const frame = JSON.parse((ev as MessageEvent).data) as InstallFrame;
            if (frame.phase === 'log') setLastLog(frame.line);
            if (frame.phase === 'error') { es.close(); reject(new Error(frame.message)); }
            if (frame.phase === 'done') { es.close(); resolve(); }
          });
          es.onerror = () => { es.close(); reject(new Error('install stream dropped')); };
        });
      }
      setStatus({ ...status, state: 'starting' });
      dismissed.current = true;
      setStatus(null); // banner gone; providers start answering via the server
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="absolute top-2 right-3 z-20 max-w-md rounded-md border bg-card/95 shadow-md px-3 py-2 text-[12px] flex items-start gap-2">
      <Download className="h-3.5 w-3.5 text-primary mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-foreground">
          Install {server.label} ({server.sizeLabel}) for completion, hover and diagnostics?
        </div>
        {installing && (
          <div className="mt-1 flex items-center gap-1.5 text-muted-foreground truncate">
            <Loader2 className="h-3 w-3 animate-spin shrink-0" />
            <span className="truncate font-mono text-[10.5px]">{lastLog || 'Installing…'}</span>
          </div>
        )}
        {error && <div className="mt-1 text-red-400 text-[11px]">{error}</div>}
        {!installing && (
          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void install()}
              className="px-2 py-0.5 rounded bg-primary text-primary-foreground text-[11px] hover:opacity-90"
            >
              Install
            </button>
            <button
              type="button"
              onClick={() => { snooze(language); dismissed.current = true; setStatus(null); }}
              className="px-2 py-0.5 rounded border text-[11px] text-muted-foreground hover:bg-muted/40"
            >
              Not now
            </button>
          </div>
        )}
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => { dismissed.current = true; setStatus(null); }}
        className="text-muted-foreground/70 hover:text-foreground"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
