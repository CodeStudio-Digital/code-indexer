import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { Switch } from '../../components/ui/switch.js';
import type { AdminMcpServer, McpTransport, McpAuthType, McpDefaultTier } from './mcp-servers-api.js';
import { HeaderRowsEditor, isReservedHeader } from './HeaderRowsEditor.js';
import { McpOAuthConnectDialog } from './McpOAuthConnectDialog.js';

interface McpServerEditDialogProps {
  initial: Partial<AdminMcpServer>;
  isExisting: boolean;
  onClose: () => void;
  onSave: (s: Partial<AdminMcpServer> & { auth_token?: string | null }) => void;
}

const TRANSPORT_VALUES: McpTransport[] = ['stdio', 'sse', 'streamable_http'];
const TRANSPORT_KEYS: Record<McpTransport, string> = {
  stdio: 'mcpServer.transportStdio',
  sse: 'mcpServer.transportSse',
  streamable_http: 'mcpServer.transportHttp',
};

const AUTH_TYPE_VALUES: McpAuthType[] = ['none', 'bearer', 'api_key', 'oauth2'];
const AUTH_TYPE_KEYS: Record<McpAuthType, string> = {
  none: 'mcpServer.authNone',
  bearer: 'mcpServer.authBearer',
  api_key: 'mcpServer.authApiKey',
  oauth2: 'mcpServer.authOAuth2',
};

const CORE_TIER_VALUES = ['bootstrap', 'navigate', 'admin', '__custom__'] as const;
const CORE_TIER_LABEL_KEYS: Record<string, string> = {
  bootstrap: 'mcpServer.tierBootstrap',
  navigate: 'mcpServer.tierNavigate',
  admin: 'mcpServer.tierAdmin',
  __custom__: 'mcpServer.tierCustom',
};
const CORE_TIER_DESC_KEYS: Record<string, string> = {
  bootstrap: 'mcpServer.tierBootstrapDesc',
  navigate: 'mcpServer.tierNavigateDesc',
  admin: 'mcpServer.tierAdminDesc',
  __custom__: 'mcpServer.tierCustomDesc',
};

const CORE_TIER_NAMES = new Set(['bootstrap', 'navigate', 'admin']);

export function McpServerEditDialog({ initial, isExisting, onClose, onSave }: McpServerEditDialogProps) {
  const { t } = useTranslation(['admin', 'common']);
  const isNew = !isExisting;
  const [form, setForm] = useState<Partial<AdminMcpServer> & { auth_token?: string }>({
    ...initial,
    auth_token: '',
  });
  // Track whether the user chose a custom tier (not one of the 3 core tiers)
  const [useCustomTier, setUseCustomTier] = useState(
    !!(initial.default_tier && !CORE_TIER_NAMES.has(initial.default_tier)),
  );

  // Custom HTTP headers live in config.headers (JSON object). Extracted to
  // a separate piece of state so the HeaderRowsEditor can operate as a
  // controlled input without forcing the whole config blob on every keystroke.
  const [headers, setHeaders] = useState<Record<string, string>>(
    () => {
      const initialConfig = (initial.config ?? {}) as Record<string, unknown>;
      const h = initialConfig.headers;
      return h && typeof h === 'object' && !Array.isArray(h)
        ? (h as Record<string, string>)
        : {};
    },
  );
  const [headerError, setHeaderError] = useState<string | null>(null);
  const [oauthDialogOpen, setOAuthDialogOpen] = useState(false);

  function update<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function submit() {
    // Reject reserved header names at the boundary — matches the backend
    // validation that will happen on the route.
    const bad = Object.keys(headers).find(isReservedHeader);
    if (bad) {
      setHeaderError(t('admin:mcpServer.headersReserved', { name: bad }) as string);
      return;
    }
    setHeaderError(null);

    // Merge headers into config without clobbering other config keys.
    const nextConfig: Record<string, unknown> = {
      ...((form.config ?? {}) as Record<string, unknown>),
    };
    if (Object.keys(headers).length > 0) {
      nextConfig.headers = headers;
    } else {
      delete nextConfig.headers;
    }

    const payload: Partial<AdminMcpServer> & { auth_token?: string | null } = {
      id: form.id,
      name: form.name,
      transport: form.transport,
      enabled: form.enabled,
      default_tier: form.default_tier,
      config: nextConfig,
    };

    // Transport-specific fields
    if (form.transport === 'stdio') {
      payload.command = form.command || null;
      payload.args = form.args ?? [];
      payload.env = form.env ?? {};
    } else {
      payload.url = form.url || null;
    }

    // Auth
    payload.auth_type = form.auth_type;
    if (form.auth_token && form.auth_token.length > 0) {
      payload.auth_token = form.auth_token;
    }

    onSave(payload);
  }

  const transport = form.transport ?? 'stdio';
  const authType = form.auth_type ?? 'none';

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{isNew ? t('admin:mcpServer.addTitle') : t('admin:mcpServer.editTitle', { name: initial.name })}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {/* ID + Name */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium">{t('admin:mcpServer.id')}</label>
              <Input
                disabled={!isNew}
                value={form.id ?? ''}
                onChange={(e) => update('id', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                placeholder={t('admin:mcpServer.idPlaceholder')}
              />
            </div>
            <div>
              <label className="text-xs font-medium">{t('admin:mcpServer.nameLabel')}</label>
              <Input
                value={form.name ?? ''}
                onChange={(e) => update('name', e.target.value)}
                placeholder={t('admin:mcpServer.namePlaceholder')}
              />
            </div>
          </div>

          {/* Transport */}
          <div>
            <label className="text-xs font-medium">{t('admin:mcpServer.transport')}</label>
            <Select
              value={transport}
              onValueChange={(v) => update('transport', v as McpTransport)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TRANSPORT_VALUES.map((tv) => (
                  <SelectItem key={tv} value={tv}>{t(`admin:${TRANSPORT_KEYS[tv]}`)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Transport-specific fields */}
          {transport === 'stdio' && (
            <>
              <div>
                <label className="text-xs font-medium">{t('admin:mcpServer.command')}</label>
                <Input
                  value={form.command ?? ''}
                  onChange={(e) => update('command', e.target.value)}
                  placeholder={t('admin:mcpServer.commandPlaceholder')}
                />
              </div>
              <div>
                <label className="text-xs font-medium">{t('admin:mcpServer.args')}</label>
                <Input
                  value={(form.args ?? []).join(' ')}
                  onChange={(e) =>
                    update('args', e.target.value.split(/\s+/).filter(Boolean) as unknown as string[])
                  }
                  placeholder={t('admin:mcpServer.argsPlaceholder')}
                />
              </div>
              <div>
                <label className="text-xs font-medium">{t('admin:mcpServer.envVars')}</label>
                <Input
                  value={JSON.stringify(form.env ?? {})}
                  onChange={(e) => {
                    try {
                      update('env', JSON.parse(e.target.value));
                    } catch { /* invalid JSON, ignore */ }
                  }}
                  placeholder={t('admin:mcpServer.envVarsPlaceholder')}
                />
              </div>
            </>
          )}

          {(transport === 'sse' || transport === 'streamable_http') && (
            <>
              <div>
                <label className="text-xs font-medium">{t('admin:mcpServer.url')}</label>
                <Input
                  value={form.url ?? ''}
                  onChange={(e) => update('url', e.target.value)}
                  placeholder={t('admin:mcpServer.urlPlaceholder')}
                />
              </div>
              <div>
                <label className="text-xs font-medium">{t('admin:mcpServer.headers')}</label>
                <p className="text-[11px] text-muted-foreground mb-1">
                  {t('admin:mcpServer.headersHint')}
                </p>
                <HeaderRowsEditor value={headers} onChange={setHeaders} />
                {headerError && (
                  <p className="text-xs text-destructive mt-1">{headerError}</p>
                )}
              </div>
            </>
          )}

          {/* Auth */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium">{t('admin:mcpServer.authType')}</label>
              <Select
                value={authType}
                onValueChange={(v) => update('auth_type', v as McpAuthType)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AUTH_TYPE_VALUES.map((av) => (
                    <SelectItem key={av} value={av}>{t(`admin:${AUTH_TYPE_KEYS[av]}`)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {authType !== 'none' && authType !== 'oauth2' && (
              <div>
                <label className="text-xs font-medium">
                  {t('admin:mcpServer.token')} {!isNew && t('admin:mcpServer.tokenKeep')}
                </label>
                <Input
                  type="password"
                  value={form.auth_token ?? ''}
                  onChange={(e) => update('auth_token', e.target.value)}
                  placeholder={isNew ? t('admin:mcpServer.tokenPlaceholder') : '\u2022\u2022\u2022\u2022'}
                />
              </div>
            )}
          </div>

          {authType === 'oauth2' && !isNew && form.id && (
            <div className="rounded border p-3 space-y-2">
              <p className="text-xs text-muted-foreground">
                {t('admin:mcpServer.oauth.editHint')}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setOAuthDialogOpen(true)}
              >
                {t('admin:mcpServer.oauth.open')}
              </Button>
            </div>
          )}
          {authType === 'oauth2' && isNew && (
            <p className="text-xs text-muted-foreground">
              {t('admin:mcpServer.oauth.saveFirst')}
            </p>
          )}

          {/* Tier */}
          <div>
            <label className="text-xs font-medium">{t('admin:mcpServer.defaultTier')}</label>
            <Select
              value={useCustomTier ? '__custom__' : (form.default_tier ?? 'navigate')}
              onValueChange={(v) => {
                if (v === '__custom__') {
                  setUseCustomTier(true);
                  // Default custom tier name to server ID
                  update('default_tier', form.id ?? '' as McpDefaultTier);
                } else {
                  setUseCustomTier(false);
                  update('default_tier', v as McpDefaultTier);
                }
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CORE_TIER_VALUES.map((tv) => (
                  <SelectItem key={tv} value={tv}>
                    {t(`admin:${CORE_TIER_LABEL_KEYS[tv]}`)} — {t(`admin:${CORE_TIER_DESC_KEYS[tv]}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {useCustomTier && (
              <div className="mt-2">
                <label className="text-xs font-medium">{t('admin:mcpServer.customTierName')}</label>
                <Input
                  value={form.default_tier ?? form.id ?? ''}
                  onChange={(e) =>
                    update('default_tier', e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '') as McpDefaultTier)
                  }
                  placeholder={form.id ?? 'cloudflare'}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Agent unlocks with <code>expand_toolset('{`{tier: "${form.default_tier || form.id || 'name'}"}`}')</code>
                </p>
              </div>
            )}
          </div>

          {/* Enabled switch */}
          <div className="flex items-center gap-6 pt-2">
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={!!form.enabled} onCheckedChange={(v) => update('enabled', v)} />
              {t('admin:mcpServer.enabled')}
            </label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button onClick={submit} disabled={!form.id || !form.name}>
            {t('common:actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
      {oauthDialogOpen && form.id && (
        <McpOAuthConnectDialog
          serverId={form.id}
          serverUrl={form.url ?? ''}
          onClose={() => setOAuthDialogOpen(false)}
        />
      )}
    </Dialog>
  );
}
