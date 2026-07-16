import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../../lib/datetime.js';
import { Trash2, Plus, Copy } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Badge } from '../../components/ui/badge.js';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '../../components/ui/dialog.js';
import { copyText } from '../../lib/clipboard.js';
import {
  createApiToken, listApiTokens, revokeApiToken, type ApiTokenRow, type McpTier,
} from './auth-api.js';

const ALL_SCOPES = ['mcp:read', 'mcp:write', 'mcp:admin'];

// Tier presets — each opens a different slice of the ~150-tool catalog
// (see packages/code-agent/src/tools/tiers.ts). The strings here mirror
// the ones the backend validates against; keep them in sync.
type TierPreset = 'bootstrap' | 'navigate' | 'admin' | 'custom';

const TIER_LABELS: Record<TierPreset, string> = {
  bootstrap: 'Bootstrap (read-only + search)',
  navigate: 'Navigate (+ edit / run / git read)',
  admin: 'Admin (everything, incl. commit / branch)',
  custom: 'Custom (manual scopes)',
};

export function ApiTokensPanel() {
  const { t } = useTranslation('admin');
  const [tokens, setTokens] = useState<ApiTokenRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [issued, setIssued] = useState<{ id: string; rawToken: string; tier: McpTier | null } | null>(null);

  const [formName, setFormName] = useState('');
  const [formTier, setFormTier] = useState<TierPreset>('bootstrap');
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
    // Custom tier means "don't bind a tier, use scopes as the only
    // gate" — sends `tier: null` so the backend keeps the legacy
    // behaviour. Otherwise the chosen tier becomes the authoritative
    // gate and the server derives a default scope set.
    const tier: McpTier | null = formTier === 'custom' ? null : formTier;
    const out = await createApiToken({
      name: formName,
      tier,
      // Only pass scopes when going custom — the server overrides scope
      // selection when a tier is bound, so sending them just adds noise
      // to the audit log.
      scopes: tier ? undefined : formScopes,
      expiresInDays: Number.isFinite(expiresInDays) ? expiresInDays : undefined,
    });
    setIssued(out);
    setFormName('');
    setFormDays('');
    setFormTier('bootstrap');
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

  // Hoisted out of the token `.map()` below — these are row-invariant, so
  // resolving them once per render avoids an i18next lookup per token row.
  const revokedLabel = t('auth.apiTokens.revoked');
  const lastUsedLabel = t('auth.apiTokens.lastUsed');

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
                {tok.tier && (
                  <Badge variant="secondary" className="font-mono text-[10px]">
                    {tok.tier}
                  </Badge>
                )}
                {tok.revoked_at && <Badge variant="destructive">{revokedLabel}</Badge>}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5 flex gap-3">
                {/* Show scopes only when no tier is bound — tier names
                    are the meaningful gate to surface; scopes become an
                    internal implementation detail. */}
                {!tok.tier && <span>{tok.scopes.join(' ')}</span>}
                {tok.last_used_at && <span>{lastUsedLabel}: {formatDateTime(tok.last_used_at)}</span>}
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
              <label className="text-sm font-medium block mb-2">{t('auth.apiTokens.tier', 'Access tier')}</label>
              <div className="grid gap-1.5">
                {(['bootstrap', 'navigate', 'admin', 'custom'] as TierPreset[]).map((tp) => (
                  <button
                    type="button"
                    key={tp}
                    onClick={() => setFormTier(tp)}
                    className={
                      'text-left px-3 py-2 rounded border text-sm transition-colors ' +
                      (formTier === tp
                        ? 'border-primary bg-primary/5 text-foreground'
                        : 'border-input hover:bg-muted/30')
                    }
                  >
                    <div className="font-medium font-mono text-xs">{tp}</div>
                    <div className="text-[11px] text-muted-foreground">{TIER_LABELS[tp]}</div>
                  </button>
                ))}
              </div>
            </div>
            {formTier === 'custom' && (
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
            )}
            <div>
              <label className="text-sm font-medium">{t('auth.apiTokens.expiresInDays')}</label>
              <Input type="number" min="1" value={formDays} onChange={(e) => setFormDays(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>{t('auth.cancel')}</Button>
            <Button
              onClick={async () => { await handleCreate(); setCreateOpen(false); }}
              disabled={!formName.trim() || (formTier === 'custom' && formScopes.length === 0)}
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
          {issued?.tier && (
            <p className="text-xs text-muted-foreground">
              Bound to tier <code className="font-mono text-foreground">{issued.tier}</code>. Pass the
              token as <code className="font-mono">Authorization: Bearer …</code>.
            </p>
          )}
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
