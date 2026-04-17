import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/badge.js';
import {
  listOAuthClients, revokeOAuthClient, type OAuthClientRow,
} from './auth-api.js';

export function OAuthClientsPanel() {
  const { t } = useTranslation('admin');
  const [clients, setClients] = useState<OAuthClientRow[]>([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try { setClients(await listOAuthClients()); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const handleRevoke = async (id: string) => {
    await revokeOAuthClient(id);
    await load();
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">{t('auth.oauthClients.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('auth.oauthClients.description')}</p>
      </div>

      {loading && <div className="text-sm text-muted-foreground">…</div>}

      <div className="rounded border divide-y">
        {clients.length === 0 && !loading && (
          <div className="p-4 text-sm text-muted-foreground">{t('auth.oauthClients.empty')}</div>
        )}
        {clients.map((cli) => (
          <div key={cli.client_id} className="flex items-center justify-between p-3 gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium truncate">{cli.client_name}</span>
                {cli.revoked_at && <Badge variant="destructive">{t('auth.oauthClients.revoked')}</Badge>}
                <Badge variant="outline" className="text-[10px]">
                  {cli.token_endpoint_auth_method}
                </Badge>
              </div>
              <div className="text-xs text-muted-foreground mt-0.5 font-mono truncate">{cli.client_id}</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {cli.scopes.join(' ')} · {cli.redirect_uris.length} redirect URI(s)
              </div>
            </div>
            {!cli.revoked_at && (
              <Button variant="ghost" size="sm" onClick={() => handleRevoke(cli.client_id)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
