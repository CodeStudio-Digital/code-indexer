import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, Pencil, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { confirm, toast } from '../../components/ui/prompt-dialog.js';
import { Switch } from '../../components/ui/switch.js';
import { CustomAgentEditDialog } from './CustomAgentEditDialog.js';
import { fetchSkills, type AdminSkill } from './skills-api.js';
import { fetchToolConfigs, type ToolConfigItem } from './tools-api.js';
import {
  fetchCustomAgents,
  removeCustomAgent,
  saveCustomAgent,
  type AgentPresetSummary,
  type CustomAgent,
  type CustomAgentDraft,
} from './custom-agents-api.js';

export function CustomAgentsPanel() {
  const { t } = useTranslation(['admin', 'common']);
  const [agents, setAgents] = useState<CustomAgent[]>([]);
  const [presets, setPresets] = useState<AgentPresetSummary[]>([]);
  const [skills, setSkills] = useState<AdminSkill[]>([]);
  const [tools, setTools] = useState<ToolConfigItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<CustomAgent | 'new' | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [agentData, skillData, toolData] = await Promise.all([
        fetchCustomAgents(),
        fetchSkills(),
        fetchToolConfigs(),
      ]);
      setAgents(agentData.agents);
      setPresets(agentData.presets);
      setSkills(skillData);
      setTools(toolData);
    } catch (error) {
      toast.error(t('admin:customAgents.loadFailed'), { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  const presetById = useMemo(() => new Map(presets.map((preset) => [preset.id, preset])), [presets]);

  const save = async (draft: CustomAgentDraft) => {
    try {
      const saved = await saveCustomAgent(editing && editing !== 'new' ? editing.id : null, draft);
      setAgents((current) => {
        const without = current.filter((agent) => agent.id !== saved.id);
        return [...without, saved].sort((a, b) => a.name.localeCompare(b.name));
      });
      setEditing(null);
      window.dispatchEvent(new CustomEvent('coder:custom-agents-changed'));
      toast.success(t('admin:customAgents.saved'));
    } catch (error) {
      toast.error(t('admin:customAgents.saveFailed'), { description: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };

  const remove = async (agent: CustomAgent) => {
    if (!(await confirm({
      title: t('admin:customAgents.deleteTitle'),
      description: t('admin:customAgents.deleteConfirm', { name: agent.name }),
      confirmLabel: t('common:actions.delete'),
      tone: 'destructive',
    }))) return;
    try {
      await removeCustomAgent(agent.id);
      setAgents((current) => current.filter((item) => item.id !== agent.id));
      window.dispatchEvent(new CustomEvent('coder:custom-agents-changed'));
    } catch (error) {
      toast.error(t('admin:customAgents.deleteFailed'), { description: error instanceof Error ? error.message : String(error) });
    }
  };

  const toggleEnabled = async (agent: CustomAgent, enabled: boolean) => {
    const draft: CustomAgentDraft = {
      name: agent.name,
      description: agent.description,
      baseAgentId: agent.baseAgentId,
      prompt: agent.prompt,
      skillIds: agent.skillIds,
      toolNames: agent.toolNames,
      enabled,
    };
    try {
      const saved = await saveCustomAgent(agent.id, draft);
      setAgents((current) => current.map((item) => item.id === saved.id ? saved : item));
      window.dispatchEvent(new CustomEvent('coder:custom-agents-changed'));
    } catch (error) {
      toast.error(t('admin:customAgents.saveFailed'), { description: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">{t('admin:customAgents.descriptionText')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('admin:customAgents.runtimeHint')}</p>
        </div>
        <Button onClick={() => setEditing('new')}>
          <Plus className="mr-2 h-4 w-4" /> {t('admin:customAgents.create')}
        </Button>
      </div>

      {loading && <div className="text-sm text-muted-foreground">{t('common:actions.loading')}</div>}
      {!loading && agents.length === 0 && (
        <div className="rounded-md border border-dashed border-border p-10 text-center">
          <Bot className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
          <div className="text-sm font-medium">{t('admin:customAgents.emptyTitle')}</div>
          <div className="mt-1 text-xs text-muted-foreground">{t('admin:customAgents.emptyHint')}</div>
        </div>
      )}

      <div className="grid gap-2 xl:grid-cols-2">
        {agents.map((agent) => {
          const preset = presetById.get(agent.baseAgentId);
          return (
            <div key={agent.id} className="rounded-md border border-border bg-card p-3">
              <div className="flex items-start gap-3">
                <div className="rounded-md bg-indigo-500/10 p-2 text-indigo-500"><Bot className="h-4 w-4" /></div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold">{agent.name}</span>
                    <Badge variant="outline" className="h-5 text-[10px]">{preset?.label ?? agent.baseAgentId}</Badge>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{agent.description || preset?.description}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-muted-foreground">
                    <span>{t('admin:customAgents.skillCount', { count: agent.skillIds.length })}</span>
                    <span>·</span>
                    <span>{agent.toolNames === null ? t('admin:customAgents.toolsInherited') : t('admin:customAgents.toolCount', { count: agent.toolNames.length })}</span>
                    {agent.prompt && <><span>·</span><span>{t('admin:customAgents.customPrompt')}</span></>}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Switch checked={agent.enabled} onCheckedChange={(enabled) => void toggleEnabled(agent, enabled)} />
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setEditing(agent)} title={t('common:actions.edit')}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => void remove(agent)} title={t('common:actions.delete')}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {editing && (
        <CustomAgentEditDialog
          initial={editing === 'new' ? null : editing}
          presets={presets}
          skills={skills}
          tools={tools}
          onClose={() => setEditing(null)}
          onSave={save}
        />
      )}
    </div>
  );
}
