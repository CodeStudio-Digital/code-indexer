import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '../../components/ui/dialog.js';
import {
  fetchOAuthStatus, registerOAuthClient, revokeMcpOAuth, startOAuthAuthorize,
  type McpOAuthStatus,
} from './mcp-servers-api.js';

type Phase = 'idle' | 'registering' | 'ready' | 'awaiting-consent' | 'connected' | 'error';

interface Props {
  serverId: string;
  serverUrl: string;  // used to derive resource_url for discovery
  onClose: () => void;
  onConnected?: () => void;
}

/**
 * Guides the user through:
 *   1. DCR (auto-register our app as a client)  OR manual registration
 *   2. Open /authorize in a popup
 *   3. Wait for postMessage from the callback page
 *   4. Show connected status (scopes)
 */
export function McpOAuthConnectDialog({ serverId, serverUrl, onClose, onConnected }: Props) {
  const { t } = useTranslation(['admin']);
  const [status, setStatus] = useState<McpOAuthStatus | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [resourceUrl, setResourceUrl] = useState(serverUrl);
  const [popup, setPopup] = useState<Window | null>(null);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  const refresh = async (): Promise<void> => {
    try {
      const s = await fetchOAuthStatus(serverId);
      setStatus(s);
      if (s.status === 'registered' && phase === 'idle') setPhase('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Listen for the callback page's postMessage.
  useEffect(() => {
    const listener = (ev: MessageEvent): void => {
      const data = ev.data as { ok?: boolean; server_id?: string; error?: string; error_description?: string };
      if (!data || typeof data !== 'object') return;
      if (data.server_id && data.server_id !== serverId) return;
      if (data.ok) {
        setPhase('connected');
        setError(null);
        onConnected?.();
      } else if (data.error) {
        setPhase('error');
        setError(data.error_description ?? data.error);
      }
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [serverId, onConnected]);

  const doRegister = async (): Promise<void> => {
    setPhase('registering');
    setError(null);
    try {
      await registerOAuthClient(serverId, { mode: 'dcr', resource_url: resourceUrl });
      await refresh();
      setPhase('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  };

  const doAuthorize = async (): Promise<void> => {
    setPhase('awaiting-consent');
    setError(null);
    try {
      const { authorization_url } = await startOAuthAuthorize(serverId);
      const win = window.open(authorization_url, 'mcp-oauth', 'width=520,height=700');
      setPopup(win);
      if (!win) {
        // Popup blocked — offer manual open.
        setError(t('admin:mcpServer.oauth.popupBlocked') as string);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  };

  const doDisconnect = async (): Promise<void> => {
    await revokeMcpOAuth(serverId);
    setStatus(null);
    setPhase('idle');
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('admin:mcpServer.oauth.title', { id: serverId })}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {!status || status.status === 'not_registered' ? (
            <>
              <p className="text-sm text-muted-foreground">
                {t('admin:mcpServer.oauth.registerHint')}
              </p>
              <div>
                <label className="text-xs font-medium">{t('admin:mcpServer.oauth.resourceUrl')}</label>
                <Input
                  value={resourceUrl}
                  onChange={(e) => setResourceUrl(e.target.value)}
                  placeholder={serverUrl || 'https://mcp.example.com'}
                />
              </div>
              <Button onClick={doRegister} disabled={!resourceUrl || phase === 'registering'}>
                {phase === 'registering'
                  ? t('admin:mcpServer.oauth.registering')
                  : t('admin:mcpServer.oauth.register')}
              </Button>
            </>
          ) : (
            <div className="space-y-2">
              <div className="text-sm">
                <div><strong>{t('admin:mcpServer.oauth.issuer')}:</strong> {status.registration?.issuer}</div>
                <div><strong>{t('admin:mcpServer.oauth.clientId')}:</strong> <code>{status.registration?.client_id}</code></div>
                <div><strong>{t('admin:mcpServer.oauth.scopes')}:</strong> {status.registration?.scopes.join(' ')}</div>
                <div><strong>{t('admin:mcpServer.oauth.source')}:</strong> {status.registration?.source}</div>
              </div>
              <div className="flex gap-2 pt-2">
                <Button onClick={doAuthorize} disabled={phase === 'awaiting-consent'}>
                  <ExternalLink className="h-4 w-4 mr-2" />
                  {phase === 'awaiting-consent'
                    ? t('admin:mcpServer.oauth.waiting')
                    : t('admin:mcpServer.oauth.authorize')}
                </Button>
                <Button variant="outline" onClick={doDisconnect}>
                  {t('admin:mcpServer.oauth.disconnect')}
                </Button>
              </div>
            </div>
          )}

          {phase === 'connected' && (
            <p className="text-sm text-emerald-600">
              {t('admin:mcpServer.oauth.connected')}
            </p>
          )}

          {popup && phase === 'awaiting-consent' && (
            <p className="text-xs text-muted-foreground">
              {t('admin:mcpServer.oauth.popupHint')}
            </p>
          )}

          {error && <p className="text-sm text-destructive break-words">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('admin:mcpServer.oauth.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
