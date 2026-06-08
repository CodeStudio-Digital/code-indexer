/**
 * MCP HTTP Status panel — surfaces the runtime state of the in-process
 * MCP HTTP server (endpoint URL, tier-by-tier tool counts, auth flags)
 * and a copy-pasteable Claude Code mcp.json snippet so the operator
 * doesn't have to hand-roll the URL/header pair.
 *
 * Sits above the existing ApiTokensPanel in the same admin section —
 * status first, then token management, then any per-tier tool drilldown
 * the user wants to see.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Globe, Loader2, RefreshCw, ShieldAlert, ShieldCheck, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/badge.js';
import { copyText } from '../../lib/clipboard.js';
import { fetchMcpHttpStatus, type McpHttpStatus } from './auth-api.js';

function buildClaudeCodeSnippet(endpoint: string, hasAuth: boolean): string {
  // Mirrors the shape Claude Code accepts in its MCP config — `transport:
  // http` + `headers`. Using a placeholder for the token so the snippet
  // never leaks a real bearer; the operator pastes their token after.
  return JSON.stringify(
    {
      mcpServers: {
        'codestudio': {
          transport: 'http',
          url: endpoint,
          ...(hasAuth
            ? { headers: { Authorization: 'Bearer <paste-your-token-here>' } }
            : {}),
        },
      },
    },
    null,
    2,
  );
}

export function McpHttpStatusPanel() {
  const { t } = useTranslation(['admin', 'common']);
  const [status, setStatus] = useState<McpHttpStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      setStatus(await fetchMcpHttpStatus());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const snippet = useMemo(
    () => (status ? buildClaudeCodeSnippet(status.endpoint, status.authEnabled) : ''),
    [status],
  );

  // Group tools by tier for the drilldown. Sort alphabetically inside
  // each tier so the catalogue reads predictably regardless of registry
  // insertion order.
  const groupedTools = useMemo(() => {
    if (!status) return null;
    const groups: Record<string, McpHttpStatus['tools']> = {
      bootstrap: [],
      navigate: [],
      admin: [],
    };
    for (const tool of status.tools) {
      (groups[tool.tier] ??= []).push(tool);
    }
    for (const list of Object.values(groups)) {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }
    return groups;
  }, [status]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Globe className="h-4 w-4" />
            {t('admin:mcpHttp.title')}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t('admin:mcpHttp.description.before')} <code className="font-mono">rag_search_docs</code>
            {t('admin:mcpHttp.description.after')}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        </Button>
      </div>

      {error && (
        <div className="rounded border border-destructive/30 bg-destructive/5 text-destructive text-sm p-3">
          {error}
        </div>
      )}

      {status && (
        <>
          <div className="rounded border bg-card/40 divide-y">
            <div className="p-3 flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                  {t('admin:mcpHttp.endpoint')}
                </div>
                <code className="font-mono text-sm break-all">{status.endpoint}</code>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void copyText(status.endpoint)}
                title={t('admin:mcpHttp.copyEndpoint')}
              >
                <Copy className="h-3.5 w-3.5 mr-1.5" />
                {t('admin:mcpHttp.copy')}
              </Button>
            </div>

            <div className="p-3 flex items-center gap-4 text-sm">
              <Badge variant={status.enabled ? 'default' : 'destructive'}>
                {status.enabled ? t('common:status.enabled') : t('common:status.disabled')}
              </Badge>
              <span className="flex items-center gap-1.5 text-muted-foreground">
                {status.authEnabled ? (
                  <>
                    <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
                    {t('admin:mcpHttp.authOn')}
                  </>
                ) : (
                  <>
                    <ShieldAlert className="h-3.5 w-3.5 text-amber-500" />
                    {t('admin:mcpHttp.authOff')}
                  </>
                )}
              </span>
              <span className="text-muted-foreground text-xs">
                {status.stateful ? t('admin:mcpHttp.stateful') : t('admin:mcpHttp.stateless')}
              </span>
              <span className="ml-auto text-xs text-muted-foreground">
                {t('admin:mcpHttp.portPath', { port: status.port })} <code className="font-mono">{status.path}</code>
              </span>
            </div>

            <div className="p-3 grid grid-cols-4 gap-3 text-sm">
              <TierStat label={t('admin:mcpHttp.total')} value={status.counts.total} />
              <TierStat label="bootstrap" value={status.counts.bootstrap} tone="muted" />
              <TierStat label="navigate" value={status.counts.navigate} tone="muted" />
              <TierStat label="admin" value={status.counts.admin} tone="muted" />
            </div>
          </div>

          <div className="rounded border bg-card/30 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">{t('admin:mcpHttp.configTitle')}</div>
              <Button variant="ghost" size="sm" onClick={() => void copyText(snippet)}>
                <Copy className="h-3.5 w-3.5 mr-1.5" />
                {t('admin:mcpHttp.copyJson')}
              </Button>
            </div>
            <pre className="text-[11px] font-mono bg-background border rounded p-2 overflow-x-auto leading-snug">
              {snippet}
            </pre>
            <p className="text-[11px] text-muted-foreground">
              {t('admin:mcpHttp.tokenHelp.before')} <code className="font-mono">Authorization</code>
              {t('admin:mcpHttp.tokenHelp.after')}
            </p>
          </div>

          {groupedTools && (
            <div className="rounded border bg-card/30">
              <button
                type="button"
                onClick={() => setToolsOpen((v) => !v)}
                className="w-full px-3 py-2 flex items-center gap-2 text-sm hover:bg-muted/30 transition-colors"
              >
                {toolsOpen ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
                <span className="font-medium">{t('admin:mcpHttp.toolsCatalog')}</span>
                <span className="text-xs text-muted-foreground ml-auto">
                  {t('admin:mcpHttp.toolsCount', { count: status.counts.total })}
                </span>
              </button>
              {toolsOpen && (
                <div className="border-t divide-y">
                  {(['bootstrap', 'navigate', 'admin'] as const).map((tier) => {
                    const list = groupedTools[tier];
                    if (!list || list.length === 0) return null;
                    return (
                      <div key={tier} className="p-3">
                        <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5">
                          <Badge variant="secondary" className="font-mono text-[10px]">
                            {tier}
                          </Badge>
                          <span>{t('admin:mcpHttp.toolsCount', { count: list.length })}</span>
                        </div>
                        <div className="grid gap-1">
                          {list.map((tool) => (
                            <div
                              key={tool.name}
                              className="flex items-baseline gap-2 text-[12px]"
                              title={tool.description}
                            >
                              <code className="font-mono text-xs shrink-0 w-56 truncate">
                                {tool.name}
                              </code>
                              <span className="text-[11px] text-muted-foreground truncate">
                                {tool.description}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function TierStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'muted';
}) {
  return (
    <div className="flex flex-col">
      <span className={'text-[11px] ' + (tone === 'muted' ? 'text-muted-foreground' : 'text-muted-foreground')}>
        {label}
      </span>
      <span className="text-lg font-semibold tabular-nums">{value}</span>
    </div>
  );
}
