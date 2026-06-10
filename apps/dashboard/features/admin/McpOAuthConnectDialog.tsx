import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '../../components/ui/dialog.js';
import {
  discoverOAuthMetadata, fetchOAuthStatus, registerOAuthClient,
  revokeMcpOAuth,
  type DiscoveredOAuthMetadata, type McpOAuthStatus, type RegisterDcrError,
} from './mcp-servers-api.js';
import { useMcpOAuthFlow } from './useMcpOAuthFlow.js';

type Phase = 'idle' | 'registering' | 'ready' | 'awaiting-consent' | 'connected' | 'error';

interface Props {
  serverId: string;
  serverUrl: string;  // used to derive resource_url for discovery
  onClose: () => void;
  onConnected?: () => void;
}

/**
 * Guides the user through:
 *   1. DCR (auto-register our app as a client) OR manual registration
 *      (when the AS rejects DCR — e.g. Figma's `/v1/oauth/mcp/register`
 *      advertises itself but returns 403 to non-pre-registered clients).
 *   2. Authorize: open the provider login in the browser. On desktop this
 *      goes to the user's real browser and the redirect is captured by an
 *      ephemeral loopback (see useMcpOAuthFlow); on web it's a popup.
 *   3. Detect completion (status polling on desktop, postMessage on web).
 *   4. Show connected status (scopes)
 */
export function McpOAuthConnectDialog({ serverId, serverUrl, onClose, onConnected }: Props) {
  const { t } = useTranslation(['admin']);
  const [status, setStatus] = useState<McpOAuthStatus | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [resourceUrl, setResourceUrl] = useState(serverUrl);

  // Manual-registration sub-form state. Activated either explicitly by
  // the user, or automatically after a DCR failure (we keep the
  // discovered AS metadata around so the manual call has what it needs).
  const [manualOpen, setManualOpen] = useState(false);
  const [manualClientId, setManualClientId] = useState('');
  const [manualClientSecret, setManualClientSecret] = useState('');
  const [manualScopes, setManualScopes] = useState('');
  const [discoveredAs, setDiscoveredAs] = useState<DiscoveredOAuthMetadata['as'] | null>(null);

  const oauth = useMcpOAuthFlow({
    onConnected: () => { setPhase('connected'); setError(null); onConnected?.(); },
    onError: (msg) => { setPhase('error'); setError(msg); },
    texts: {
      loopbackError: t('admin:mcpServer.oauth.loopbackError') as string,
      popupBlocked: t('admin:mcpServer.oauth.popupBlocked') as string,
      timeout: t('admin:mcpServer.oauth.timeout') as string,
    },
  });

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

  const doRegister = async (): Promise<void> => {
    setPhase('registering');
    setError(null);
    try {
      await registerOAuthClient(serverId, { mode: 'dcr', resource_url: resourceUrl });
      await refresh();
      setPhase('ready');
    } catch (e) {
      const dcrErr = e as RegisterDcrError;
      setError(dcrErr.message);
      setPhase('error');
      // If the backend surfaced the discovered AS, preload the manual
      // form so the user can paste credentials without re-running
      // discovery — Figma's 403 path lands here.
      if (dcrErr.as) {
        setDiscoveredAs(dcrErr.as);
        if (dcrErr.scopes_supported && dcrErr.scopes_supported.length > 0) {
          setManualScopes(dcrErr.scopes_supported.join(' '));
        }
        setManualOpen(true);
      }
    }
  };

  const openManual = async (): Promise<void> => {
    setError(null);
    if (!discoveredAs) {
      try {
        const meta = await discoverOAuthMetadata(serverId, resourceUrl);
        setDiscoveredAs(meta.as);
        const supported = meta.resource.scopes_supported.length > 0
          ? meta.resource.scopes_supported
          : (meta.as.scopes_supported ?? []);
        if (supported.length > 0) setManualScopes(supported.join(' '));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
    }
    setManualOpen(true);
  };

  const submitManual = async (): Promise<void> => {
    if (!discoveredAs || !manualClientId.trim()) return;
    setPhase('registering');
    setError(null);
    try {
      const scopes = manualScopes.trim() ? manualScopes.trim().split(/\s+/) : undefined;
      await registerOAuthClient(serverId, {
        mode: 'manual',
        as: discoveredAs,
        client_id: manualClientId.trim(),
        client_secret: manualClientSecret.trim() || undefined,
        scopes,
      });
      await refresh();
      setPhase('ready');
      setManualOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  };

  const doAuthorize = async (): Promise<void> => {
    setPhase('awaiting-consent');
    setError(null);
    await oauth.authorize(serverId);
  };

  const doDisconnect = async (): Promise<void> => {
    oauth.cancel();
    await revokeMcpOAuth(serverId);
    setStatus(null);
    setPhase('idle');
    setManualOpen(false);
    setDiscoveredAs(null);
    setManualClientId('');
    setManualClientSecret('');
    setManualScopes('');
  };

  const handleClose = (): void => {
    oauth.cancel();
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && handleClose()}>
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
              <div className="flex gap-2">
                <Button onClick={doRegister} disabled={!resourceUrl || phase === 'registering'}>
                  {phase === 'registering'
                    ? t('admin:mcpServer.oauth.registering')
                    : t('admin:mcpServer.oauth.register')}
                </Button>
                <Button variant="outline" onClick={openManual} disabled={phase === 'registering'}>
                  {t('admin:mcpServer.oauth.useManual')}
                </Button>
              </div>

              {manualOpen && (
                <div className="space-y-3 rounded border p-3 bg-muted/30">
                  <p className="text-xs text-muted-foreground">
                    {t('admin:mcpServer.oauth.manualHint')}
                  </p>
                  {discoveredAs?.issuer && (
                    <div className="text-xs">
                      <strong>{t('admin:mcpServer.oauth.issuer')}:</strong>{' '}
                      <code>{discoveredAs.issuer}</code>
                    </div>
                  )}
                  <div>
                    <label className="text-xs font-medium">{t('admin:mcpServer.oauth.manualClientId')}</label>
                    <Input
                      value={manualClientId}
                      onChange={(e) => setManualClientId(e.target.value)}
                      placeholder="abc123…"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium">{t('admin:mcpServer.oauth.manualClientSecret')}</label>
                    <Input
                      type="password"
                      value={manualClientSecret}
                      onChange={(e) => setManualClientSecret(e.target.value)}
                      placeholder={t('admin:mcpServer.oauth.manualClientSecretPlaceholder') as string}
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium">{t('admin:mcpServer.oauth.manualScopes')}</label>
                    <Input
                      value={manualScopes}
                      onChange={(e) => setManualScopes(e.target.value)}
                      placeholder="mcp:connect"
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button
                      onClick={submitManual}
                      disabled={!manualClientId.trim() || !discoveredAs || phase === 'registering'}
                    >
                      {phase === 'registering'
                        ? t('admin:mcpServer.oauth.registering')
                        : t('admin:mcpServer.oauth.manualSubmit')}
                    </Button>
                    <Button variant="ghost" onClick={() => setManualOpen(false)}>
                      {t('admin:mcpServer.oauth.cancel')}
                    </Button>
                  </div>
                </div>
              )}
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

          {phase === 'awaiting-consent' && (
            <p className="text-xs text-muted-foreground">
              {t('admin:mcpServer.oauth.popupHint')}
            </p>
          )}

          {error && <p className="text-sm text-destructive break-words">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={handleClose}>
            {t('admin:mcpServer.oauth.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
