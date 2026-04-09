import { useState } from 'react';
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

interface McpServerEditDialogProps {
  initial: Partial<AdminMcpServer>;
  isExisting: boolean;
  onClose: () => void;
  onSave: (s: Partial<AdminMcpServer> & { auth_token?: string | null }) => void;
}

const TRANSPORTS: { value: McpTransport; label: string }[] = [
  { value: 'stdio', label: 'stdio (local process)' },
  { value: 'sse', label: 'SSE (Server-Sent Events)' },
  { value: 'streamable_http', label: 'Streamable HTTP' },
];

const AUTH_TYPES: { value: McpAuthType; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'bearer', label: 'Bearer Token' },
  { value: 'api_key', label: 'API Key (header)' },
];

const CORE_TIERS: { value: string; label: string; desc: string }[] = [
  { value: 'bootstrap', label: 'Bootstrap', desc: 'Always visible (turn 1)' },
  { value: 'navigate', label: 'Navigate', desc: 'Visible after expand_toolset("navigate")' },
  { value: 'admin', label: 'Admin', desc: 'Only with --profile full' },
  { value: '__custom__', label: 'Custom tier', desc: 'On-demand: agent calls expand_toolset("<name>")' },
];

const CORE_TIER_NAMES = new Set(['bootstrap', 'navigate', 'admin']);

export function McpServerEditDialog({ initial, isExisting, onClose, onSave }: McpServerEditDialogProps) {
  const isNew = !isExisting;
  const [form, setForm] = useState<Partial<AdminMcpServer> & { auth_token?: string }>({
    ...initial,
    auth_token: '',
  });
  // Track whether the user chose a custom tier (not one of the 3 core tiers)
  const [useCustomTier, setUseCustomTier] = useState(
    !!(initial.default_tier && !CORE_TIER_NAMES.has(initial.default_tier)),
  );

  function update<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function submit() {
    const payload: Partial<AdminMcpServer> & { auth_token?: string | null } = {
      id: form.id,
      name: form.name,
      transport: form.transport,
      enabled: form.enabled,
      default_tier: form.default_tier,
      config: form.config ?? {},
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
          <DialogTitle>{isNew ? 'Add MCP Server' : `Edit ${initial.name}`}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {/* ID + Name */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium">ID (slug)</label>
              <Input
                disabled={!isNew}
                value={form.id ?? ''}
                onChange={(e) => update('id', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                placeholder="github"
              />
            </div>
            <div>
              <label className="text-xs font-medium">Display name</label>
              <Input
                value={form.name ?? ''}
                onChange={(e) => update('name', e.target.value)}
                placeholder="GitHub MCP"
              />
            </div>
          </div>

          {/* Transport */}
          <div>
            <label className="text-xs font-medium">Transport</label>
            <Select
              value={transport}
              onValueChange={(v) => update('transport', v as McpTransport)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TRANSPORTS.map((t) => (
                  <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Transport-specific fields */}
          {transport === 'stdio' && (
            <>
              <div>
                <label className="text-xs font-medium">Command</label>
                <Input
                  value={form.command ?? ''}
                  onChange={(e) => update('command', e.target.value)}
                  placeholder="npx"
                />
              </div>
              <div>
                <label className="text-xs font-medium">Arguments (space-separated)</label>
                <Input
                  value={(form.args ?? []).join(' ')}
                  onChange={(e) =>
                    update('args', e.target.value.split(/\s+/).filter(Boolean) as unknown as string[])
                  }
                  placeholder="-y @modelcontextprotocol/server-github"
                />
              </div>
              <div>
                <label className="text-xs font-medium">Environment variables (JSON)</label>
                <Input
                  value={JSON.stringify(form.env ?? {})}
                  onChange={(e) => {
                    try {
                      update('env', JSON.parse(e.target.value));
                    } catch { /* invalid JSON, ignore */ }
                  }}
                  placeholder='{"GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..."}'
                />
              </div>
            </>
          )}

          {(transport === 'sse' || transport === 'streamable_http') && (
            <div>
              <label className="text-xs font-medium">URL</label>
              <Input
                value={form.url ?? ''}
                onChange={(e) => update('url', e.target.value)}
                placeholder="https://mcp.example.com/sse"
              />
            </div>
          )}

          {/* Auth */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium">Auth type</label>
              <Select
                value={authType}
                onValueChange={(v) => update('auth_type', v as McpAuthType)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AUTH_TYPES.map((a) => (
                    <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {authType !== 'none' && (
              <div>
                <label className="text-xs font-medium">
                  Token {!isNew && '(leave blank to keep)'}
                </label>
                <Input
                  type="password"
                  value={form.auth_token ?? ''}
                  onChange={(e) => update('auth_token', e.target.value)}
                  placeholder={isNew ? 'ghp_...' : '\u2022\u2022\u2022\u2022'}
                />
              </div>
            )}
          </div>

          {/* Tier */}
          <div>
            <label className="text-xs font-medium">Default tool tier</label>
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
                {CORE_TIERS.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label} — {t.desc}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {useCustomTier && (
              <div className="mt-2">
                <label className="text-xs font-medium">Custom tier name</label>
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
              Enabled
            </label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!form.id || !form.name}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
