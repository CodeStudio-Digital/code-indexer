import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, ChevronDown, ChevronRight, Loader2, Pencil, Plus, Server, Trash2, XCircle, Zap } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { McpServerEditDialog } from './McpServerEditDialog.js';
import { useAdminMcpServers } from './hooks/useAdminMcpServers.js';
import type { AdminMcpServer, McpServerTestResult, McpServerToolInfo } from './mcp-servers-api.js';

const TRANSPORT_LABEL: Record<string, string> = {
  stdio: 'stdio',
  sse: 'SSE',
  streamable_http: 'HTTP',
};

const CORE_TIERS: Record<string, string> = {
  bootstrap: 'Bootstrap',
  navigate: 'Navigate',
  admin: 'Admin',
};

function tierLabel(tier: string): string {
  return CORE_TIERS[tier] ?? tier;
}

function TestBadge({ tr }: { tr: McpServerTestResult | undefined }) {
  const { t } = useTranslation('admin');
  if (!tr) return null;
  if (tr.error === 'testing\u2026' || tr.error === 'testing…') {
    return <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />;
  }
  if (tr.ok) {
    return (
      <span className="flex items-center gap-1 text-xs text-emerald-600">
        <CheckCircle2 className="h-3 w-3" />
        {tr.toolCount}{t('mcpServers.tools')}{tr.latencyMs}{t('mcpServers.ms')}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-xs text-red-600" title={tr.error}>
      <XCircle className="h-3 w-3" /> {t('mcpServers.fail')}
    </span>
  );
}

function ToolsList({ tools }: { tools: McpServerToolInfo[] }) {
  if (tools.length === 0) return null;
  return (
    <div className="mt-2 space-y-1">
      {tools.map((t) => (
        <div key={t.name} className="flex items-start gap-2 text-xs">
          <code className="text-muted-foreground shrink-0 font-mono">{t.name.replace(/^ext_[^_]+(?:_[^_]+)*__/, '')}</code>
          <span className="text-muted-foreground truncate">{t.description}</span>
        </div>
      ))}
    </div>
  );
}

export function McpServersPanel() {
  const { t } = useTranslation(['admin', 'common']);
  const { servers, loading, testResults, load, save, remove, test } = useAdminMcpServers();
  const [editing, setEditing] = useState<Partial<AdminMcpServer> | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Button
          onClick={() =>
            setEditing({
              transport: 'stdio',
              auth_type: 'none',
              default_tier: 'navigate',
              enabled: true,
              args: [],
              env: {},
              config: {},
            })
          }
        >
          <Plus className="h-4 w-4 mr-2" /> {t('admin:mcpServers.addServer')}
        </Button>
      </div>

      {loading && <div className="text-sm text-muted-foreground">{t('common:actions.loading')}</div>}

      <div className="grid gap-3">
        {servers.map((s) => {
          const tr = testResults[s.id];
          const isExpanded = expanded.has(s.id);
          const hasTools = tr?.ok && tr.tools && tr.tools.length > 0;

          return (
            <Card key={s.id} className="overflow-hidden">
              <CardHeader className="py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    {hasTools ? (
                      <button
                        onClick={() => toggleExpand(s.id)}
                        className="shrink-0 text-muted-foreground hover:text-foreground"
                      >
                        {isExpanded
                          ? <ChevronDown className="h-4 w-4" />
                          : <ChevronRight className="h-4 w-4" />}
                      </button>
                    ) : (
                      <Server className="h-4 w-4 text-muted-foreground shrink-0" />
                    )}
                    <CardTitle className="text-base truncate">{s.name}</CardTitle>
                    <Badge variant="outline">{TRANSPORT_LABEL[s.transport] ?? s.transport}</Badge>
                    <Badge variant="secondary">{tierLabel(s.default_tier)}</Badge>
                    {!s.enabled && <Badge variant="secondary">{t('admin:mcpServers.disabled')}</Badge>}
                    {s.has_token ? (
                      <span className="text-xs text-muted-foreground font-mono">{s.auth_token_masked}</span>
                    ) : s.auth_type !== 'none' ? (
                      <span className="text-xs text-amber-600">{t('admin:mcpServers.noToken')}</span>
                    ) : null}
                    <TestBadge tr={tr} />
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button size="sm" variant="ghost" onClick={() => test(s.id)}>
                      <Zap className="h-4 w-4 mr-1" /> {t('common:actions.test')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => remove(s.id)}>
                      <Trash2 className="h-4 w-4 text-red-600" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="py-2 text-xs text-muted-foreground">
                {s.transport === 'stdio' && s.command && (
                  <code>{s.command} {s.args.join(' ')}</code>
                )}
                {(s.transport === 'sse' || s.transport === 'streamable_http') && s.url && (
                  <code>{s.url}</code>
                )}
                {isExpanded && hasTools && <ToolsList tools={tr.tools!} />}
              </CardContent>
            </Card>
          );
        })}
        {!loading && servers.length === 0 && (
          <div className="text-sm text-muted-foreground border rounded-lg p-6 text-center">
            {t('admin:mcpServers.noServers')}
          </div>
        )}
      </div>

      {editing && (
        <McpServerEditDialog
          initial={editing}
          isExisting={!!servers.find((x) => x.id === editing.id)}
          onClose={() => setEditing(null)}
          onSave={async (s) => {
            await save(s);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}
