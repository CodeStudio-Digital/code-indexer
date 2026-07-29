import { useState } from 'react';
import { Crown, ExternalLink, Loader2, ShieldCheck, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button } from '../../../components/ui/button.js';
import { WorkbenchPanelHeader } from '../../../components/workbench/index.js';
import { useApi } from '../../../hooks/useApi.js';
import { useProviders } from '../../../hooks/useProviders.js';
import { buildAgentsDefaultUrl } from '../../agents/routing.js';
import { RoleEditModal, type RoleConfig, type SkillDef } from '../../agents/RoleEditModal.js';
import { OperationalRulesEditor } from '../../agents/session-view/OperationalRulesEditor.js';
import {
  updateAppTeamConfig,
  type AppTeamConfigView,
  type AppTeamRoleConfig,
} from '../app-studio-api.js';

interface EditingRole {
  index: number;
  draft: RoleConfig;
}

function inheritedToolTiers(role: RoleConfig): string[] {
  const tiers = new Set<string>(['bootstrap', 'company', 'app']);
  if (role.tier === 'navigate' || role.tier === 'full') tiers.add('navigate');
  if (role.tier === 'full') tiers.add('admin');
  if (role.role === 'master') tiers.add('master');
  if (role.role === 'database') tiers.add('db');
  if (['frontend', 'ux', 'qa', 'fullstack'].includes(role.role)) tiers.add('preview');
  return [...tiers];
}

function editShape(role: AppTeamRoleConfig): RoleConfig {
  const fallback = role.fallbackModels[0];
  return {
    role: role.role,
    provider: role.provider,
    model: role.model,
    tier: role.tier,
    skills: role.skills,
    initialTools: role.initialTools,
    systemPromptOverride: role.systemPromptOverride,
    temperature: role.temperature,
    reasoningEffort: role.reasoningEffort,
    thinking: role.thinking,
    thinkingBudgetTokens: role.thinkingBudgetTokens,
    fallback_provider: fallback?.provider,
    fallback_model: fallback?.model,
  };
}

function persistedShape(current: AppTeamRoleConfig, draft: RoleConfig): AppTeamRoleConfig {
  const fallback = draft.fallback_provider && draft.fallback_model
    ? [{ provider: draft.fallback_provider, model: draft.fallback_model }]
    : [];
  return {
    ...current,
    role: current.role,
    provider: draft.provider,
    model: draft.model,
    tier: current.role === 'master' ? 'navigate' : draft.tier,
    skills: draft.skills,
    initialTools: draft.initialTools,
    systemPromptOverride: draft.systemPromptOverride,
    temperature: draft.temperature,
    reasoningEffort: draft.reasoningEffort,
    thinking: draft.thinking,
    thinkingBudgetTokens: draft.thinkingBudgetTokens,
    fallbackModels: fallback,
  };
}

export function AppTeamPanel({ appSessionId, onCollapse }: { appSessionId: string; onCollapse?: () => void }) {
  const { t } = useTranslation('appStudio');
  const navigate = useNavigate();
  const { data, loading, error, refetch, update } = useApi<AppTeamConfigView>(`/app-studio/apps/${appSessionId}/team/config`);
  const { data: skillsList } = useApi<{ skills: SkillDef[] }>('/admin/skills');
  const { providerOptions, getModelsForProvider } = useProviders();
  const [editing, setEditing] = useState<EditingRole | null>(null);
  const [savingRole, setSavingRole] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const team = data && Array.isArray(data.roles) ? data : null;
  const contractError = data && !team ? t('v6.team.outdatedApi') : null;

  const saveRules = async (operationalRules: string) => {
    setSaveError(null);
    try {
      const next = await updateAppTeamConfig(appSessionId, { operational_rules: operationalRules });
      update(() => next);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setSaveError(message);
      throw cause;
    }
  };

  const saveRole = async () => {
    if (!team || !editing || savingRole) return;
    setSavingRole(true);
    setSaveError(null);
    try {
      const roles = team.roles.map((role, index) => index === editing.index ? persistedShape(role, editing.draft) : role);
      const next = await updateAppTeamConfig(appSessionId, { roles });
      update(() => next);
      setEditing(null);
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingRole(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkbenchPanelHeader
        title={t('v6.team.title')}
        icon={Users}
        onClose={onCollapse}
        closeLabel={t('v6.team.collapse')}
        actions={team ? (
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <span className={`h-1.5 w-1.5 rounded-full ${team.status === 'running' ? 'bg-emerald-400' : team.status === 'error' ? 'bg-red-400' : 'bg-slate-400'}`} />
            {t(`v6.team.status.${team.status}`)}
          </span>
        ) : undefined}
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {loading && !data && <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t('v6.team.loading')}</div>}
        {(error || saveError || contractError) && <p className="mb-3 rounded border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-500">{saveError ?? error ?? contractError}</p>}

        {team && (
          <div className="space-y-5">
            <section className="space-y-2">
              <div>
                <h3 className="flex items-center gap-1.5 text-xs font-semibold"><ShieldCheck className="h-3.5 w-3.5 text-violet-400" />{t('v6.team.rulesTitle')}</h3>
                <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{t('v6.team.rulesHint')}</p>
              </div>
              <OperationalRulesEditor
                sessionId={team.company_session_id}
                value={team.operational_rules}
                refetch={refetch}
                onSave={saveRules}
              />
            </section>

            <section className="space-y-2">
              <div>
                <h3 className="text-xs font-semibold">{t('v6.team.rolesTitle')}</h3>
                <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{t('v6.team.rolesHint')}</p>
              </div>
              <div className="space-y-1.5">
                {team.roles.map((role, index) => {
                  const fallback = role.fallbackModels[0];
                  return (
                    <button
                      type="button"
                      key={role.role}
                      onClick={() => { setSaveError(null); setEditing({ index, draft: editShape(role) }); }}
                      className="w-full rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-raised)] p-2.5 text-left transition-colors hover:border-violet-500/40 hover:bg-[var(--workbench-hover)]"
                    >
                      <span className="flex items-center gap-2">
                        {role.role === 'master' ? <Crown className="h-3.5 w-3.5 text-amber-400" /> : <Users className="h-3.5 w-3.5 text-muted-foreground" />}
                        <span className="min-w-0 flex-1 truncate text-xs font-medium">{role.role === 'master' ? t('v6.team.master') : role.role}</span>
                        <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[9px] text-violet-300">{role.tier}</span>
                      </span>
                      <span className="mt-1.5 block truncate font-mono text-[10px] text-muted-foreground">{role.provider} · {role.model}</span>
                      <span className="mt-1 flex items-center gap-2 text-[9px] text-muted-foreground">
                        <span>{t('v6.team.skillCount', { count: role.skills?.length ?? 0 })}</span>
                        <span>·</span>
                        <span>{t('v6.team.toolCount', { count: role.initialTools?.length ?? 0 })}</span>
                        <span>·</span>
                        <span className="truncate">{fallback ? t('v6.team.fallbackValue', { provider: fallback.provider, model: fallback.model }) : t('v6.team.noFallback')}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
              <p className="text-[10px] leading-relaxed text-muted-foreground">{t('v6.team.failoverHint')}</p>
            </section>

            <Button variant="outline" size="sm" className="w-full justify-between text-xs" onClick={() => navigate(buildAgentsDefaultUrl(team.company_session_id))}>
              {t('v6.team.openAgents')}<ExternalLink className="h-3.5 w-3.5" />
            </Button>
            <p className="text-center text-[9px] text-muted-foreground">{t('v6.team.advancedHint')}</p>
          </div>
        )}
      </div>

      {editing && (
        <RoleEditModal
          role={editing.draft}
          roleIdx={editing.index}
          availableSkills={skillsList?.skills ?? []}
          providerOptions={providerOptions}
          getModelsForProvider={(providerId) => getModelsForProvider(providerId).map((model) => ({
            ...model,
            mode: model.mode ?? undefined,
          }))}
          onUpdate={(patch) => setEditing((current) => current ? { ...current, draft: { ...current.draft, ...patch } } : current)}
          onClose={() => void saveRole()}
          onCancel={() => setEditing(null)}
          roleNameReadOnly
          inheritedToolTiers={inheritedToolTiers(editing.draft)}
          availableToolNames={team?.roles[editing.index]?.availableToolNames}
        />
      )}
      {savingRole && <div className="pointer-events-none fixed inset-0 z-[70] grid place-items-center bg-black/20"><Loader2 className="h-5 w-5 animate-spin text-white" /></div>}
    </div>
  );
}
