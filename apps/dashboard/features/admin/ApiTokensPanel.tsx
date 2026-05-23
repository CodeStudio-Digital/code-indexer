import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2, Plus, Copy } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Badge } from '../../components/ui/badge.js';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '../../components/ui/dialog.js';
import { copyText } from '../../lib/clipboard.js';
import {
  createApiToken, listApiTokens, revokeApiToken, type ApiTokenRow,
} from './auth-api.js';

const ALL_SCOPES = ['mcp:read', 'mcp:write', 'mcp:admin'];

export function ApiTokensPanel() {
  const { t } = useTranslation('admin');
  const [tokens, setTokens] = useState<ApiTokenRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [issued, setIssued] = useState<{ id: string; rawToken: string } | null>(null);

  const [formName, setFormName] = useState('');
  const [formScopes, setFormScopes] = useState<string[]>(['mcp:read', 'mcp:write']);
  const [formDays, setFormDays] = useState<string>('');

  const load = async () => {
    setLoading(true);
    try { setTokens(await listApiTokens()); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const handleCreate = async () => {
    const expiresInDays = formDays ? Number(formDays) : undefined;
    const out = await createApiToken({
      name: formName,
      scopes: formScopes,
      expiresInDays: Number.isFinite(expiresInDays) ? expiresInDays : undefined,
    });
    setIssued(out);
    setFormName('');
    setFormDays('');
    setFormScopes(['mcp:read', 'mcp:write']);
    await load();
  };

  const handleRevoke = async (id: string) => {
    await revokeApiToken(id);
    await load();
  };

  const toggleScope = (s: string) => {
    setFormScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">{t('auth.apiTokens.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('auth.apiTokens.description')}</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />{t('auth.apiTokens.create')}
        </Button>
      </div>

      {loading && <div className="text-sm text-muted-foreground">…</div>}

      <div className="rounded border divide-y">
        {tokens.length === 0 && !loading && (
          <div className="p-4 text-sm text-muted-foreground">{t('auth.apiTokens.empty')}</div>
        )}
        {tokens.map((tok) => (
          <div key={tok.id} className="flex items-center justify-between p-3 gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium truncate">{tok.name}</span>
                {tok.revoked_at && <Badge variant="destructive">{t('auth.apiTokens.revoked')}</Badge>}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5 flex gap-3">
                <span>{tok.scopes.join(' ')}</span>
                {tok.last_used_at && <span>{t('auth.apiTokens.lastUsed')}: {new Date(tok.last_used_at).toLocaleString()}</span>}
              </div>
            </div>
            {!tok.revoked_at && (
              <Button variant="ghost" size="sm" onClick={() => handleRevoke(tok.id)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        ))}
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('auth.apiTokens.create')}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium">{t('auth.apiTokens.name')}</label>
              <Input value={formName} onChange={(e) => setFormName(e.target.value)} />
            </div>
            <div>
              <label className="text-sm font-medium block mb-2">{t('auth.apiTokens.scopes')}</label>
              <div className="flex gap-2 flex-wrap">
                {ALL_SCOPES.map((s) => (
                  <button
                    type="button"
                    key={s}
                    onClick={() => toggleScope(s)}
                    className={
                      'px-2 py-1 rounded text-xs border ' +
                      (formScopes.includes(s) ? 'bg-primary text-primary-foreground' : 'bg-background')
                    }
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-sm font-medium">{t('auth.apiTokens.expiresInDays')}</label>
              <Input type="number" min="1" value={formDays} onChange={(e) => setFormDays(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>{t('auth.cancel')}</Button>
            <Button
              onClick={async () => { await handleCreate(); setCreateOpen(false); }}
              disabled={!formName.trim() || formScopes.length === 0}
            >
              {t('auth.apiTokens.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={issued !== null} onOpenChange={(o) => { if (!o) setIssued(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('auth.apiTokens.copyOnce')}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">{t('auth.apiTokens.copyOnceHint')}</p>
          <div className="bg-muted rounded p-2 font-mono text-xs break-all">
            {issued?.rawToken}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => { if (issued) void copyText(issued.rawToken); }}
            >
              <Copy className="h-4 w-4 mr-2" />{t('auth.apiTokens.copy')}
            </Button>
            <Button onClick={() => setIssued(null)}>{t('auth.done')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
