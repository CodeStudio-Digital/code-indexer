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
import { Copy, Globe, Loader2, RefreshCw, ShieldAlert, ShieldCheck, ChevronDown, ChevronRight, Plus, Trash2, Bot, Link2 } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/badge.js';
import { Input } from '../../components/ui/input.js';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { copyText } from '../../lib/clipboard.js';
import {
  deleteMcpConnectionProfile,
  exportMcpAgent,
  fetchMcpHttpStatus,
  installCodexMcpBridge,
  listMcpConnectionProfiles,
  saveMcpConnectionProfile,
  type McpConnectionProfile,
  type McpHttpStatus,
} from './auth-api.js';

export function McpHttpStatusPanel() {
  const { t } = useTranslation(['admin', 'common']);
  const [status, setStatus] = useState<McpHttpStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [profiles, setProfiles] = useState<McpConnectionProfile[]>([]);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileId, setProfileId] = useState('');
  const [profileName, setProfileName] = useState('');
  const [profileDescription, setProfileDescription] = useState('');
  const [profileProjects, setProfileProjects] = useState<number[]>([]);
  const [profileAgents, setProfileAgents] = useState<string[]>([]);
  const [profileTools, setProfileTools] = useState('');
  const [profileApproval, setProfileApproval] = useState<'read_only' | 'controlled' | 'admin'>('controlled');
  const [profileConcurrency, setProfileConcurrency] = useState('2');
  const [profileRuntimeMinutes, setProfileRuntimeMinutes] = useState('30');
  const [selectedAgent, setSelectedAgent] = useState('');
  const [bridgeNote, setBridgeNote] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [nextStatus, nextProfiles] = await Promise.all([
        fetchMcpHttpStatus(),
        listMcpConnectionProfiles(),
      ]);
      setStatus(nextStatus);
      setProfiles(nextProfiles);
      setSelectedAgent((current) => current || nextStatus.agents[0]?.id || '');
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

  const createProfile = async () => {
    await saveMcpConnectionProfile({
      id: profileId.trim(),
      name: profileName.trim(),
      description: profileDescription.trim(),
      projectIds: profileProjects,
      toolAllowlist: profileTools.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean),
      agentAllowlist: profileAgents,
      approvalMode: profileApproval,
      maxConcurrentRuns: Number(profileConcurrency),
      maxRuntimeMs: Number(profileRuntimeMinutes) * 60_000,
    });
    setProfileOpen(false);
    setProfileId('');
    setProfileName('');
    setProfileDescription('');
    setProfileProjects([]);
    setProfileAgents([]);
    setProfileTools('');
    await load();
  };

  const copyAgentExport = async (target: 'claude' | 'codex') => {
    if (!selectedAgent) return;
    const exported = await exportMcpAgent(selectedAgent, target);
    await copyText(`# ${exported.fileName}\n${exported.content}`);
  };

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

          <div className="rounded border bg-card/30 p-3 space-y-3">
            <div className="text-sm font-medium">{t('admin:mcpHttp.configTitle')}</div>
            <ClientConfig
              label="Claude Code / Cursor"
              content={status.configs.claudeCode}
              copyLabel={t('admin:mcpHttp.copyJson')}
            />
            <ClientConfig
              label="Codex"
              content={status.configs.codex}
              copyLabel={t('admin:mcpHttp.copy')}
            />
            <p className="text-[11px] text-muted-foreground">
              {t('admin:mcpHttp.tokenHelp.before')} <code className="font-mono">Authorization</code>
              {t('admin:mcpHttp.tokenHelp.after')}
            </p>
          </div>

          <div className="rounded border bg-card/30 p-3 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">{t('admin:mcpHttp.profiles', 'Connection profiles')}</div>
                <div className="text-[11px] text-muted-foreground">
                  {t('admin:mcpHttp.profilesHint', 'Bind projects, tools, agents and runtime limits to an API token.')}
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={() => setProfileOpen(true)}>
                <Plus className="h-3.5 w-3.5 mr-1.5" />
                {t('admin:mcpHttp.newProfile', 'New profile')}
              </Button>
            </div>
            {profiles.length === 0 ? (
              <div className="text-xs text-muted-foreground">{t('admin:mcpHttp.noProfiles', 'No connection profile yet.')}</div>
            ) : (
              <div className="divide-y rounded border">
                {profiles.map((profile) => (
                  <div key={profile.id} className="flex items-center gap-3 p-2.5 text-xs">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium truncate">{profile.name}</span>
                        <Badge variant="secondary" className="font-mono text-[9px]">{profile.approvalMode}</Badge>
                      </div>
                      <div className="text-[10px] text-muted-foreground mt-1">
                        {profile.projectIds.length || t('admin:mcpHttp.allProjects', 'all projects')} ·{' '}
                        {profile.toolAllowlist.length || t('admin:mcpHttp.allTools', 'all tools')} ·{' '}
                        {profile.agentAllowlist.length || t('admin:mcpHttp.allAgents', 'all agents')} ·{' '}
                        {t('admin:mcpHttp.runLimits', {
                          runs: profile.maxConcurrentRuns,
                          minutes: Math.round(profile.maxRuntimeMs / 60_000),
                          defaultValue: '{{runs}} runs / {{minutes}} min',
                        })}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={async () => { await deleteMcpConnectionProfile(profile.id); await load(); }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded border bg-card/30 p-3 space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Bot className="h-4 w-4" />
              {t('admin:mcpHttp.agentBridge', 'Agent bridge')}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={selectedAgent}
                onChange={(event) => setSelectedAgent(event.target.value)}
                className="min-w-60 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {status.agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>{agent.name}</option>
                ))}
              </select>
              <Button variant="outline" size="sm" onClick={() => void copyAgentExport('claude')}>
                <Copy className="h-3.5 w-3.5 mr-1.5" />{t('admin:mcpHttp.copyClaudeAgent', 'Claude agent')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => void copyAgentExport('codex')}>
                <Copy className="h-3.5 w-3.5 mr-1.5" />{t('admin:mcpHttp.copyCodexAgent', 'Codex agent')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => setBridgeNote((await installCodexMcpBridge()).note)}
              >
                <Link2 className="h-3.5 w-3.5 mr-1.5" />
                {t('admin:mcpHttp.installCodexBridge', 'Use Codex as MCP')}
              </Button>
            </div>
            <div className="text-[11px] text-muted-foreground">
              {bridgeNote ?? t('admin:mcpHttp.agentBridgeHint', 'Exports native agent files and can register codex mcp-server back inside CodeStudio.')}
            </div>
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
                              <Badge variant="outline" className="ml-auto font-mono text-[9px] shrink-0">
                                {tool.scope}
                              </Badge>
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

      <Dialog open={profileOpen} onOpenChange={setProfileOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{t('admin:mcpHttp.newProfile', 'New profile')}</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium">{t('admin:mcpHttp.profileId', 'ID')}</label>
                <Input value={profileId} onChange={(event) => setProfileId(event.target.value.toLowerCase())} placeholder={t('admin:mcpHttp.profileIdPlaceholder', 'claude-build')} />
              </div>
              <div>
                <label className="text-xs font-medium">{t('admin:mcpHttp.profileName', 'Name')}</label>
                <Input value={profileName} onChange={(event) => setProfileName(event.target.value)} />
              </div>
            </div>
            <div>
              <label className="text-xs font-medium">{t('admin:mcpHttp.profileDescription', 'Description')}</label>
              <Input value={profileDescription} onChange={(event) => setProfileDescription(event.target.value)} />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-xs font-medium">{t('admin:mcpHttp.approvalMode', 'Approval mode')}</label>
                <select value={profileApproval} onChange={(event) => setProfileApproval(event.target.value as typeof profileApproval)} className="w-full rounded-md border border-input bg-background px-2 py-2 text-sm">
                  <option value="read_only">{t('admin:mcpHttp.readOnly', 'read_only')}</option>
                  <option value="controlled">{t('admin:mcpHttp.controlled', 'controlled')}</option>
                  <option value="admin">{t('admin:mcpHttp.adminMode', 'admin')}</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-medium">{t('admin:mcpHttp.concurrentRuns', 'Concurrent runs')}</label>
                <Input type="number" min="1" max="16" value={profileConcurrency} onChange={(event) => setProfileConcurrency(event.target.value)} />
              </div>
              <div>
                <label className="text-xs font-medium">{t('admin:mcpHttp.runtimeMinutes', 'Runtime (minutes)')}</label>
                <Input type="number" min="1" max="1440" value={profileRuntimeMinutes} onChange={(event) => setProfileRuntimeMinutes(event.target.value)} />
              </div>
            </div>
            <ProfileChoices
              title={t('admin:mcpHttp.projects', 'Projects (empty means all)')}
              values={status?.projects.map((project) => ({ id: String(project.id), label: project.name })) ?? []}
              selected={profileProjects.map(String)}
              onToggle={(id) => setProfileProjects((current) => current.includes(Number(id)) ? current.filter((value) => value !== Number(id)) : [...current, Number(id)])}
            />
            <ProfileChoices
              title={t('admin:mcpHttp.agents', 'Agents (empty means all)')}
              values={status?.agents.map((agent) => ({ id: agent.id, label: agent.name })) ?? []}
              selected={profileAgents}
              onToggle={(id) => setProfileAgents((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id])}
            />
            <div>
              <label className="text-xs font-medium">{t('admin:mcpHttp.toolAllowlist', 'Tool allowlist (empty means all)')}</label>
              <textarea
                value={profileTools}
                onChange={(event) => setProfileTools(event.target.value)}
                placeholder={t('admin:mcpHttp.toolAllowlistPlaceholder', 'search, read_file, start_agent_run')}
                className="mt-1 min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setProfileOpen(false)}>{t('common:actions.cancel')}</Button>
            <Button onClick={() => void createProfile()} disabled={!profileId.trim() || !profileName.trim()}>{t('common:actions.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ProfileChoices({
  title,
  values,
  selected,
  onToggle,
}: {
  title: string;
  values: Array<{ id: string; label: string }>;
  selected: string[];
  onToggle: (id: string) => void;
}) {
  return (
    <div>
      <div className="text-xs font-medium mb-1">{title}</div>
      <div className="grid grid-cols-2 gap-1 max-h-36 overflow-y-auto rounded border p-2">
        {values.map((value) => (
          <label key={value.id} className="flex items-center gap-2 text-xs rounded px-1 py-1 hover:bg-muted/30">
            <input type="checkbox" checked={selected.includes(value.id)} onChange={() => onToggle(value.id)} />
            <span className="truncate">{value.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function ClientConfig({ label, content, copyLabel }: { label: string; content: string; copyLabel: string }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium text-muted-foreground">{label}</div>
        <Button variant="ghost" size="sm" onClick={() => void copyText(content)}>
          <Copy className="h-3.5 w-3.5 mr-1.5" />
          {copyLabel}
        </Button>
      </div>
      <pre className="text-[11px] font-mono bg-background border rounded p-2 overflow-x-auto leading-snug">
        {content}
      </pre>
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
