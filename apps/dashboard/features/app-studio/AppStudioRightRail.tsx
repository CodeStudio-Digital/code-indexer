import { useEffect, useMemo, useState } from 'react';
import { Activity, Bot, ChevronDown, FileText, Loader2, MessageSquare, RefreshCcw, Save, Settings2, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button.js';
import { RailButton, RailContainer } from '../../components/chrome/index.js';
import { AgentRuntimeFields, SkillAssignmentEditor } from '../../components/agent-config/index.js';
import { useProviders } from '../../hooks/useProviders.js';
import { AppStudioChatRail } from './AppStudioChatRail.js';
import {
  getAppAgentOverview,
  saveAppAgentConfig,
  saveAppAgentRuntime,
  type AppAgentConfigView,
  type AppAgentOverviewView,
  type AppAgentRunView,
} from './app-studio-api.js';

export type AppStudioSidePanel = 'agents' | 'prompts' | 'sessions' | 'chat';

const EMPTY_CONFIG: AppAgentConfigView = { v: 1, coordinator_prompt: '', coordinator_skills: [], profiles: {} };

export function AppStudioRightRail({ active, onToggle }: { active: AppStudioSidePanel | null; onToggle: (panel: AppStudioSidePanel) => void }) {
  const { t } = useTranslation('appStudio');
  const items: Array<{ id: AppStudioSidePanel; icon: typeof Bot; label: string }> = [
    { id: 'agents', icon: Bot, label: t('agentRail.agents', { defaultValue: 'Agentes' }) },
    { id: 'prompts', icon: FileText, label: t('agentRail.prompts', { defaultValue: 'Prompts adicionais' }) },
    { id: 'sessions', icon: Activity, label: t('agentRail.sessions', { defaultValue: 'Sessões e execuções' }) },
    { id: 'chat', icon: MessageSquare, label: t('agentRail.chat', { defaultValue: 'Chat do coordenador' }) },
  ];
  return (
    <RailContainer side="right" aria-label={t('agentRail.label', { defaultValue: 'Painéis dos agentes' })}>
      {items.map((item) => <RailButton key={item.id} icon={item.icon} label={item.label} side="right" role="toggle" active={active === item.id} onClick={() => onToggle(item.id)} />)}
    </RailContainer>
  );
}

function useAgentOverview(sessionId: number, refreshKey: string) {
  const [data, setData] = useState<AppAgentOverviewView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refresh = async () => {
    setLoading(true);
    try { setData(await getAppAgentOverview(sessionId)); setError(null); }
    catch (cause) { setError((cause as Error).message); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, [sessionId, refreshKey]);
  return { data, setData, loading, error, refresh };
}

function PanelHeader({ icon: Icon, title, loading, onRefresh }: { icon: typeof Bot; title: string; loading?: boolean; onRefresh?: () => void }) {
  return (
    <header className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--workbench-border)] bg-[var(--workbench-raised)] px-2.5">
      <Icon className="h-3.5 w-3.5 text-primary" />
      <span className="min-w-0 flex-1 truncate text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{title}</span>
      {onRefresh && <Button variant="ghost" size="icon" className="h-6 w-6" disabled={loading} onClick={onRefresh}>{loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}</Button>}
    </header>
  );
}

const statusColor = (status: string) => status === 'running' ? 'bg-emerald-500' : status === 'error' || status === 'failed' ? 'bg-red-500' : 'bg-muted-foreground';
const formatTokens = (value: number | null | undefined) => value == null ? '—' : value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(value);
const formatDuration = (value: number | null) => value == null ? '—' : value >= 60_000 ? `${(value / 60_000).toFixed(1)} min` : `${(value / 1_000).toFixed(1)} s`;

function AgentsPanel({ sessionId, overview, onSaved, onRuntimeSaved }: { sessionId: number; overview: AppAgentOverviewView; onSaved: (config: AppAgentConfigView) => void; onRuntimeSaved: (runtime: { provider: string; model: string; reasoning_effort: string | null }) => void }) {
  const { t } = useTranslation('appStudio');
  const coordinator = overview.coordinator;
  const { providerOptions, getModelsForProvider, loading: providersLoading } = useProviders();
  const [runtime, setRuntime] = useState({ provider: coordinator?.provider ?? '', model: coordinator?.model ?? '', reasoningEffort: coordinator?.reasoning_effort ?? undefined as string | undefined });
  const [draft, setDraft] = useState<AppAgentConfigView>(overview.config ?? EMPTY_CONFIG);
  const [runtimeExpanded, setRuntimeExpanded] = useState(false);
  const [expandedProfile, setExpandedProfile] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => { setRuntime({ provider: coordinator?.provider ?? '', model: coordinator?.model ?? '', reasoningEffort: coordinator?.reasoning_effort ?? undefined }); }, [coordinator?.provider, coordinator?.model, coordinator?.reasoning_effort]);
  useEffect(() => { setDraft(overview.config ?? EMPTY_CONFIG); }, [overview.config]);
  const updateProfile = (name: string, patch: Partial<AppAgentConfigView['profiles'][string]>) => setDraft((current) => ({ ...current, profiles: { ...current.profiles, [name]: { enabled: true, additional_prompt: '', skills: [], ...current.profiles[name], ...patch } } }));
  const save = async () => {
    setSaving(true); setNotice(null);
    try {
      if (coordinator) {
        const savedRuntime = await saveAppAgentRuntime(sessionId, { provider: runtime.provider, model: runtime.model, reasoning_effort: runtime.reasoningEffort ?? null });
        onRuntimeSaved(savedRuntime);
      }
      const config = await saveAppAgentConfig(sessionId, draft);
      setDraft(config); onSaved(config);
      setNotice(t('agentRail.saved', { defaultValue: 'Configuração salva e aplicada aos próximos despachos.' }));
    } catch (cause) { setNotice((cause as Error).message); }
    finally { setSaving(false); }
  };
  return (
    <div className="space-y-3 p-3">
      <section className="rounded-lg border bg-card p-3">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${statusColor(coordinator?.status ?? 'idle')}`} />
          <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{t('workflow.coordinator')}</p><p className="truncate text-[10px] text-muted-foreground">{coordinator ? `${coordinator.provider} · ${coordinator.model}` : '—'}</p></div>
          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[9px] text-primary">{t('agentRail.master')}</span>
        </div>
        {coordinator && <div className="mt-3 grid grid-cols-3 gap-2 text-center"><Metric label={t('agentRail.metrics.input')} value={formatTokens(coordinator.total_input_tokens)} /><Metric label={t('agentRail.metrics.output')} value={formatTokens(coordinator.total_output_tokens)} /><Metric label={t('agentRail.metrics.context')} value={formatTokens(coordinator.last_turn_input_tokens)} /></div>}
        {coordinator && <div className="mt-2 flex flex-wrap gap-1 text-[9px] text-muted-foreground"><span className="rounded bg-muted px-1.5 py-0.5">{coordinator.agent ?? 'app_orchestrator'}</span><span className="rounded bg-muted px-1.5 py-0.5">{t('agentRail.tools', { value: coordinator.tool_permission_mode ?? 'auto' })}</span><span className="rounded bg-muted px-1.5 py-0.5">{t('agentRail.reasoning', { value: runtime.reasoningEffort ?? 'auto' })}</span></div>}
        {overview.config.coordinator_prompt && <p className="mt-3 line-clamp-3 rounded bg-muted/50 p-2 text-[10px] text-muted-foreground">{overview.config.coordinator_prompt}</p>}
      </section>

      <section className="overflow-hidden rounded-lg border bg-card">
        <button type="button" aria-expanded={runtimeExpanded} onClick={() => setRuntimeExpanded((current) => !current)} className="flex w-full items-center gap-2 p-3 text-left hover:bg-muted/30">
          <Settings2 className="h-3.5 w-3.5 shrink-0 text-primary" />
          <div className="min-w-0 flex-1"><h3 className="truncate text-xs font-semibold">{t('agentRail.runtimeTitle')}</h3><p className="truncate text-[9px] text-muted-foreground">{runtime.provider || t('agentRail.providerFallback')} · {runtime.model || t('agentRail.modelFallback')} · {runtime.reasoningEffort ?? 'auto'}</p></div>
          <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${runtimeExpanded ? 'rotate-180' : ''}`} />
        </button>
        {runtimeExpanded && <div className="space-y-3 border-t p-3">
          <p className="text-[9px] text-muted-foreground">{t('agentRail.runtimeHint')}</p>
          {coordinator ? <AgentRuntimeFields value={runtime} providerOptions={providerOptions} getModelsForProvider={getModelsForProvider} disabled={saving || providersLoading} compact onChange={(patch) => setRuntime((current) => ({ ...current, ...patch }))} /> : <p className="text-[10px] text-muted-foreground">{t('agentRail.coordinatorUnavailable')}</p>}
          <details className="border-t pt-2">
            <summary className="cursor-pointer text-[10px] font-medium text-muted-foreground">{t('agentRail.coordinatorSkills', { count: draft.coordinator_skills.length })}</summary>
            <div className="mt-2"><SkillAssignmentEditor skills={overview.available_skills} selected={draft.coordinator_skills} compact onChange={(skills) => setDraft((current) => ({ ...current, coordinator_skills: skills }))} /></div>
          </details>
        </div>}
      </section>

      <section>
        <div className="mb-2 flex items-center gap-2"><Settings2 className="h-3.5 w-3.5 text-muted-foreground" /><h3 className="text-xs font-semibold">{t('agentRail.profiles', { defaultValue: 'Perfis especializados' })}</h3><span className="ml-auto rounded-full bg-muted px-1.5 text-[10px]">{overview.profiles.length}</span></div>
        <div className="space-y-2">
          {overview.profiles.map((profile) => {
            const config = draft.profiles[profile.name] ?? { enabled: profile.enabled, additional_prompt: profile.additional_prompt, skills: profile.skills };
            const expanded = expandedProfile === profile.name;
            return <article key={profile.name} className={`rounded-lg border bg-card ${expanded ? 'border-primary/30' : ''}`}>
              <button type="button" onClick={() => setExpandedProfile((current) => current === profile.name ? null : profile.name)} className="flex w-full items-center gap-2 p-2.5 text-left"><span className={`h-1.5 w-1.5 rounded-full ${config.enabled ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`} /><strong className="min-w-0 flex-1 truncate text-xs">{profile.name}</strong>{config.skills.length > 0 && <span className="rounded bg-primary/10 px-1 text-[9px] text-primary">{t('agentRail.skillCount', { count: config.skills.length })}</span>}<span className="text-[9px] text-muted-foreground">{profile.active_cards}/{profile.cards}</span><ChevronDown className={`h-3 w-3 transition-transform ${expanded ? 'rotate-180' : ''}`} /></button>
              {expanded && <div className="space-y-3 border-t p-2.5"><label className="flex items-center gap-2 text-[10px]"><input type="checkbox" checked={config.enabled} onChange={(event) => updateProfile(profile.name, { enabled: event.target.checked })} /><span>{t('agentRail.dispatchAsSubagent')}</span></label><SkillAssignmentEditor skills={overview.available_skills} selected={config.skills} compact onChange={(skills) => updateProfile(profile.name, { skills })} /><label className="block"><span className="mb-1 block text-[10px] font-medium text-muted-foreground">{t('agentRail.profileAdditionalPrompt')}</span><textarea className="min-h-20 w-full resize-y rounded border bg-background p-2 text-[10px]" value={config.additional_prompt} onChange={(event) => updateProfile(profile.name, { additional_prompt: event.target.value })} placeholder={t('agentRail.profilePromptPlaceholder')} /></label><p className="text-[9px] text-muted-foreground">{t('agentRail.recordedRuns', { count: profile.runs })}</p></div>}
            </article>;
          })}
        </div>
      </section>
      {notice && <p className="rounded border bg-muted/30 p-2 text-[10px] text-muted-foreground">{notice}</p>}
      <Button size="sm" className="w-full" disabled={saving || !runtime.provider || !runtime.model} onClick={() => void save()}>{saving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1 h-3.5 w-3.5" />}{t('agentRail.save')}</Button>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded bg-muted/50 p-1.5"><div className="text-xs font-semibold">{value}</div><div className="text-[8px] uppercase tracking-wide text-muted-foreground">{label}</div></div>;
}

function PromptsPanel({ sessionId, overview, onSaved }: { sessionId: number; overview: AppAgentOverviewView; onSaved: (config: AppAgentConfigView) => void }) {
  const { t } = useTranslation('appStudio');
  const [draft, setDraft] = useState<AppAgentConfigView>(overview.config ?? EMPTY_CONFIG);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => { setDraft(overview.config ?? EMPTY_CONFIG); }, [overview.config]);
  const profiles = useMemo(() => overview.profiles.map((profile) => profile.name), [overview.profiles]);
  const updateProfile = (name: string, patch: Partial<AppAgentConfigView['profiles'][string]>) => setDraft((current) => ({ ...current, profiles: { ...current.profiles, [name]: { enabled: true, additional_prompt: '', skills: [], ...current.profiles[name], ...patch } } }));
  const save = async () => {
    setSaving(true); setNotice(null);
    try { const config = await saveAppAgentConfig(sessionId, draft); setDraft(config); onSaved(config); setNotice(t('agentRail.saved', { defaultValue: 'Configuração salva.' })); }
    catch (cause) { setNotice((cause as Error).message); }
    finally { setSaving(false); }
  };
  return (
    <div className="space-y-4 p-3">
      <label className="block"><span className="mb-1 block text-xs font-semibold">{t('agentRail.coordinatorPrompt', { defaultValue: 'Prompt adicional do coordenador' })}</span><textarea className="min-h-28 w-full resize-y rounded-md border bg-background p-2 text-xs" value={draft.coordinator_prompt} onChange={(event) => setDraft((current) => ({ ...current, coordinator_prompt: event.target.value }))} placeholder={t('agentRail.promptPlaceholder', { defaultValue: 'Instruções específicas deste app, sem repetir o prompt-base…' })} /></label>
      <div className="space-y-3">
        {profiles.map((name) => {
          const config = draft.profiles[name] ?? { enabled: true, additional_prompt: '', skills: [] };
          return <section key={name} className="rounded-lg border bg-card p-2.5"><label className="flex items-center gap-2 text-xs font-semibold"><input type="checkbox" checked={config.enabled} onChange={(event) => updateProfile(name, { enabled: event.target.checked })} /><span className="flex-1">{name}</span><span className="text-[9px] font-normal text-muted-foreground">{t('agentRail.cardCount', { count: overview.profiles.find((profile) => profile.name === name)?.cards ?? 0 })}</span></label><textarea className="mt-2 min-h-20 w-full resize-y rounded border bg-background p-2 text-[11px]" value={config.additional_prompt} onChange={(event) => updateProfile(name, { additional_prompt: event.target.value })} placeholder={t('agentRail.profilePromptPlaceholder', { defaultValue: 'Critérios, padrões e limites adicionais para este perfil…' })} /></section>;
        })}
      </div>
      {notice && <p className="text-[10px] text-muted-foreground">{notice}</p>}
      <Button size="sm" className="w-full" disabled={saving} onClick={() => void save()}>{saving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1 h-3.5 w-3.5" />}{t('agentRail.save', { defaultValue: 'Salvar configuração' })}</Button>
    </div>
  );
}

function SessionsPanel({ overview }: { overview: AppAgentOverviewView }) {
  const { t } = useTranslation('appStudio');
  const [selectedId, setSelectedId] = useState<string | null>(overview.coordinator ? 'coordinator' : overview.runs[0]?.run_id ?? null);
  useEffect(() => {
    if (selectedId === 'coordinator' && overview.coordinator) return;
    if (selectedId && overview.runs.some((run) => run.run_id === selectedId)) return;
    setSelectedId(overview.coordinator ? 'coordinator' : overview.runs[0]?.run_id ?? null);
  }, [overview.coordinator, overview.runs, selectedId]);
  const selected = overview.runs.find((run) => run.run_id === selectedId) ?? null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b p-2">
        <button type="button" onClick={() => overview.coordinator && setSelectedId('coordinator')} className={`w-full rounded-lg border p-2 text-left transition-colors ${selectedId === 'coordinator' ? 'border-primary/50 bg-primary/5' : 'bg-card hover:bg-muted/40'}`}><div className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${statusColor(overview.coordinator?.status ?? 'idle')}`} /><strong className="min-w-0 flex-1 truncate text-xs">{t('workflow.coordinator')}</strong><span className="font-mono text-[9px] text-muted-foreground">#{overview.coordinator?.id ?? '—'}</span></div><p className="mt-1 truncate text-[10px] text-muted-foreground">{overview.coordinator ? `${overview.coordinator.provider} · ${overview.coordinator.model}` : '—'}</p></button>
      </div>
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(120px,0.9fr)_minmax(180px,1.1fr)]">
        <div className="overflow-y-auto border-b p-2">
          <p className="mb-2 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">{t('agentRail.agentRuns', { defaultValue: 'Execuções dos agentes' })}</p>
          <div className="space-y-1.5">{overview.runs.map((run) => <RunRow key={run.run_id} run={run} selected={run.run_id === selectedId} onClick={() => setSelectedId(run.run_id)} />)}{overview.runs.length === 0 && <p className="rounded border border-dashed p-3 text-center text-[10px] text-muted-foreground">{t('agentRail.noRuns', { defaultValue: 'Nenhum subagente executado ainda.' })}</p>}</div>
        </div>
        <div className="overflow-y-auto p-3">{selectedId === 'coordinator' && overview.coordinator ? <CoordinatorDetail coordinator={overview.coordinator} /> : selected ? <RunDetail run={selected} /> : <div className="flex h-full items-center justify-center text-xs text-muted-foreground">{t('agentRail.selectRun', { defaultValue: 'Selecione uma execução.' })}</div>}</div>
      </div>
    </div>
  );
}

function CoordinatorDetail({ coordinator }: { coordinator: NonNullable<AppAgentOverviewView['coordinator']> }) {
  const { t } = useTranslation('appStudio');
  return <div className="space-y-3"><div><div className="flex items-center gap-2"><Bot className="h-4 w-4 text-primary" /><strong className="min-w-0 flex-1 truncate text-sm">{coordinator.title}</strong><span className="rounded bg-muted px-1.5 text-[9px]">{coordinator.status}</span></div><p className="mt-1 font-mono text-[9px] text-muted-foreground">{t('agentRail.sessionNumber', { id: coordinator.id })}</p></div><div className="grid grid-cols-3 gap-1"><Metric label={t('agentRail.metrics.input')} value={formatTokens(coordinator.total_input_tokens)} /><Metric label={t('agentRail.metrics.output')} value={formatTokens(coordinator.total_output_tokens)} /><Metric label={t('agentRail.metrics.context')} value={formatTokens(coordinator.last_turn_input_tokens)} /></div><dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 rounded border bg-muted/20 p-2 text-[10px]"><dt className="text-muted-foreground">{t('agentRail.detail.agent')}</dt><dd className="truncate font-mono">{coordinator.agent ?? 'app_orchestrator'}</dd><dt className="text-muted-foreground">{t('agentRail.detail.model')}</dt><dd className="truncate">{coordinator.provider} · {coordinator.model}</dd><dt className="text-muted-foreground">{t('agentRail.detail.permissions')}</dt><dd>{coordinator.tool_permission_mode ?? 'auto'}</dd><dt className="text-muted-foreground">{t('agentRail.detail.reasoning')}</dt><dd>{coordinator.reasoning_effort ?? 'auto'}</dd><dt className="text-muted-foreground">{t('agentRail.detail.updated')}</dt><dd>{new Date(coordinator.updated_at).toLocaleString()}</dd></dl></div>;
}

function RunRow({ run, selected, onClick }: { run: AppAgentRunView; selected: boolean; onClick: () => void }) {
  return <button type="button" onClick={onClick} className={`w-full rounded-md border p-2 text-left transition-colors ${selected ? 'border-primary/50 bg-primary/5' : 'bg-card hover:bg-muted/40'}`}><div className="flex items-center gap-2"><span className={`h-1.5 w-1.5 rounded-full ${statusColor(run.completed_at ? run.reason ?? 'idle' : 'running')}`} /><strong className="min-w-0 flex-1 truncate text-[11px]">{run.label || run.profile}</strong><span className="text-[9px] text-muted-foreground">{formatDuration(run.elapsed_ms)}</span></div><p className="mt-1 line-clamp-1 text-[9px] text-muted-foreground">{run.task_preview || run.run_id}</p></button>;
}

function RunDetail({ run }: { run: AppAgentRunView }) {
  const { t } = useTranslation('appStudio');
  return <div className="space-y-3"><div><div className="flex items-center gap-2"><Bot className="h-4 w-4 text-primary" /><strong className="text-sm">{run.label || run.profile}</strong><span className="ml-auto rounded bg-muted px-1.5 text-[9px]">{run.reason ?? 'running'}</span></div><p className="mt-1 font-mono text-[9px] text-muted-foreground">{run.profile} · {run.run_id}</p><p className="mt-2 whitespace-pre-wrap text-[10px] text-muted-foreground">{run.task_preview || '—'}</p></div><div className="grid grid-cols-4 gap-1"><Metric label={t('agentRail.metrics.turns')} value={String(run.turns)} /><Metric label={t('agentRail.metrics.tools')} value={String(run.tool_calls)} /><Metric label={t('agentRail.metrics.input')} value={formatTokens(run.input_tokens)} /><Metric label={t('agentRail.metrics.output')} value={formatTokens(run.output_tokens)} /></div><div className="grid grid-cols-3 gap-1"><Metric label={t('agentRail.metrics.productive')} value={String(run.productive_operations)} /><Metric label={t('agentRail.metrics.errors')} value={String(run.error_calls)} /><Metric label={t('agentRail.metrics.duration')} value={formatDuration(run.elapsed_ms)} /></div><section><div className="mb-1 flex items-center gap-1"><Wrench className="h-3 w-3 text-muted-foreground" /><span className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">{t('agentRail.toolCalls')}</span></div><div className="space-y-1">{run.tool_calls_detail.map((call) => <div key={call.id} className={`flex items-center gap-2 rounded border px-2 py-1 text-[9px] ${call.is_error ? 'border-red-500/30 bg-red-500/5' : 'bg-muted/25'}`}><span className="min-w-0 flex-1 truncate font-mono">{call.tool_name}</span><span>{t('agentRail.durationMs', { count: call.duration_ms })}</span><span>{t('agentRail.characterCount', { count: call.result_chars })}</span></div>)}{run.tool_calls_detail.length === 0 && <p className="rounded border border-dashed p-2 text-center text-[9px] text-muted-foreground">{t('agentRail.noToolCalls')}</p>}</div></section></div>;
}

export function AppStudioRightPanel({
  active,
  appSessionId,
  projectId,
  projectName,
  coordinatorSessionId,
  initialPrompt,
  refreshKey,
  onCoordinatorChanged,
}: {
  active: AppStudioSidePanel;
  appSessionId: number;
  projectId: number;
  projectName: string;
  coordinatorSessionId: number | null;
  initialPrompt?: string | null;
  refreshKey: string;
  onCoordinatorChanged?: (coderSessionId: number) => void | Promise<void>;
}) {
  const { t } = useTranslation('appStudio');
  const state = useAgentOverview(appSessionId, refreshKey);
  if (active === 'chat') return <AppStudioChatRail appSessionId={appSessionId} projectId={projectId} projectName={projectName} coordinatorSessionId={coordinatorSessionId} initialPrompt={initialPrompt} onCoordinatorChanged={onCoordinatorChanged} />;
  const icons = { agents: Bot, prompts: FileText, sessions: Activity } as const;
  const labels = { agents: t('agentRail.agents', { defaultValue: 'Agentes' }), prompts: t('agentRail.prompts', { defaultValue: 'Prompts adicionais' }), sessions: t('agentRail.sessions', { defaultValue: 'Sessões e execuções' }) };
  const applyConfig = (config: AppAgentConfigView) => state.setData((current) => current ? {
    ...current,
    config,
    profiles: current.profiles.map((profile) => ({
      ...profile,
      enabled: config.profiles[profile.name]?.enabled !== false,
      additional_prompt: config.profiles[profile.name]?.additional_prompt ?? '',
      skills: config.profiles[profile.name]?.skills ?? [],
    })),
  } : current);
  return <div className="flex h-full min-h-0 flex-col bg-[var(--workbench-surface)]"><PanelHeader icon={icons[active]} title={labels[active]} loading={state.loading} onRefresh={() => void state.refresh()} />{state.error && <p className="m-2 rounded border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-700">{state.error}</p>}{!state.data && state.loading ? <div className="flex flex-1 items-center justify-center"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div> : state.data ? <div className="min-h-0 flex-1 overflow-y-auto">{active === 'agents' ? <AgentsPanel sessionId={appSessionId} overview={state.data} onSaved={applyConfig} onRuntimeSaved={(runtime) => state.setData((current) => current?.coordinator ? { ...current, coordinator: { ...current.coordinator, provider: runtime.provider, model: runtime.model, reasoning_effort: runtime.reasoning_effort } } : current)} /> : active === 'prompts' ? <PromptsPanel sessionId={appSessionId} overview={state.data} onSaved={applyConfig} /> : <SessionsPanel overview={state.data} />}</div> : null}</div>;
}
