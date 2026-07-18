import { useMemo, useState } from 'react';
import { BookOpen, MessageSquareText, Search, Settings2, Wrench } from 'lucide-react';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select.js';
import { Switch } from '../../components/ui/switch.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { Textarea } from '../../components/ui/textarea.js';
import { ToolAssignmentEditor } from '../../components/agent-config/ToolAssignmentEditor.js';
import type { AdminSkill } from './skills-api.js';
import type { ToolConfigItem } from './tools-api.js';
import type {
  AgentPresetSummary,
  CustomAgent,
  CustomAgentDraft,
} from './custom-agents-api.js';
import type { BuiltInAgentPreset } from '@mcp/api-bus';

interface Props {
  initial: CustomAgent | null;
  presets: AgentPresetSummary[];
  skills: AdminSkill[];
  tools: ToolConfigItem[];
  onClose: () => void;
  onSave: (draft: CustomAgentDraft) => Promise<void>;
}

function toggleItem(items: string[], id: string, enabled: boolean): string[] {
  return enabled ? [...new Set([...items, id])] : items.filter((item) => item !== id);
}

export function CustomAgentEditDialog({ initial, presets, skills, tools, onClose, onSave }: Props) {
  const { t } = useTranslation(['admin', 'common']);
  const [form, setForm] = useState<CustomAgentDraft>(() => ({
    name: initial?.name ?? '',
    description: initial?.description ?? '',
    baseAgentId: initial?.baseAgentId ?? 'build',
    prompt: initial?.prompt ?? '',
    skillIds: initial?.skillIds ?? [],
    toolNames: initial?.toolNames ?? null,
    enabled: initial?.enabled ?? true,
  }));
  const [skillQuery, setSkillQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [lastCustomToolNames, setLastCustomToolNames] = useState<string[] | null>(initial?.toolNames ?? null);
  const selectedPreset = presets.find((preset) => preset.id === form.baseAgentId);
  const fallbackPresetTiers = selectedPreset?.profile === 'full'
    ? ['bootstrap', 'navigate', 'admin']
    : selectedPreset?.profile === 'navigate'
      ? ['bootstrap', 'navigate']
      : ['bootstrap'];
  const inheritedToolTiers = selectedPreset?.defaultToolTiers ?? fallbackPresetTiers;
  const inheritedToolNames = selectedPreset?.defaultToolNames?.length
    ? selectedPreset.defaultToolNames
    : tools.filter((tool) => inheritedToolTiers.includes(tool.tier)).map((tool) => tool.name);
  const inheritedTools = tools.filter((tool) => (
    inheritedToolTiers.includes(tool.tier) || inheritedToolNames.includes(tool.name)
  ));

  const visibleSkills = useMemo(() => {
    const query = skillQuery.trim().toLocaleLowerCase();
    return skills
      .filter((skill) => skill.enabled)
      .filter((skill) => !query || `${skill.name} ${skill.id} ${skill.description}`.toLocaleLowerCase().includes(query));
  }, [skillQuery, skills]);
  const submit = async () => {
    if (!form.name.trim() || saving) return;
    setSaving(true);
    try {
      await onSave({ ...form, name: form.name.trim(), description: form.description.trim() });
    } catch {
      // Parent owns the localized toast; keep the dialog open for correction.
    } finally {
      setSaving(false);
    }
  };

  const setCustomToolMode = (custom: boolean) => {
    if (!custom) {
      if (form.toolNames !== null) setLastCustomToolNames(form.toolNames);
      setForm((current) => ({ ...current, toolNames: null }));
      return;
    }
    setForm((current) => ({
      ...current,
      toolNames: lastCustomToolNames ?? inheritedToolNames,
    }));
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="h-[min(760px,88vh)] w-[min(880px,calc(100vw-2rem))] max-w-4xl grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-5 py-4 pr-12">
          <DialogTitle>
            {initial ? t('admin:customAgents.editTitle', { name: initial.name }) : t('admin:customAgents.createTitle')}
          </DialogTitle>
          <p className="text-xs text-muted-foreground">{t('admin:customAgents.dialogHint')}</p>
        </DialogHeader>

        <Tabs defaultValue="general" className="flex min-h-0 min-w-0 flex-col overflow-hidden">
          <TabsList className="mx-5 mt-4 grid h-9 w-auto shrink-0 grid-cols-4 p-0.5">
            <TabsTrigger value="general" className="h-8 text-xs">
              <Settings2 /> {t('admin:customAgents.tabGeneral')}
            </TabsTrigger>
            <TabsTrigger value="skills" className="h-8 text-xs">
              <BookOpen /> {t('admin:customAgents.tabSkills')} ({form.skillIds.length})
            </TabsTrigger>
            <TabsTrigger value="tools" className="h-8 text-xs">
              <Wrench /> {t('admin:customAgents.tabTools')} ({form.toolNames === null ? t('admin:customAgents.inheritedShort') : form.toolNames.length})
            </TabsTrigger>
            <TabsTrigger value="prompt" className="h-8 text-xs">
              <MessageSquareText /> {t('admin:customAgents.tabPrompt')}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="general" className="m-0 min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-5">
            <div className="mx-auto max-w-3xl space-y-5">
              <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                <div className="min-w-0">
                  <label className="text-sm font-medium">{t('admin:customAgents.name')}</label>
                  <Input
                    autoFocus
                    value={form.name}
                    maxLength={80}
                    onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                    placeholder={t('admin:customAgents.namePlaceholder')}
                  />
                </div>
                <div className="min-w-0">
                  <label className="text-sm font-medium">{t('admin:customAgents.basePreset')}</label>
                  <Select
                    value={form.baseAgentId}
                    onValueChange={(value) => setForm((current) => ({ ...current, baseAgentId: value as BuiltInAgentPreset }))}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {presets.map((preset) => (
                        <SelectItem key={preset.id} value={preset.id}>
                          {preset.label} — {preset.profile}{preset.planMode ? ` · ${t('admin:customAgents.planGate')}` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="mt-1 text-xs leading-4 text-muted-foreground">{t('admin:customAgents.basePresetHint')}</p>
                </div>
              </div>

              <div className="min-w-0">
                <label className="text-sm font-medium">{t('admin:customAgents.description')}</label>
                <Input
                  value={form.description}
                  maxLength={240}
                  onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
                  placeholder={t('admin:customAgents.descriptionPlaceholder')}
                />
              </div>

              <label className="flex items-center gap-2 rounded-md border border-border px-3 py-2.5 text-sm">
                <Switch checked={form.enabled} onCheckedChange={(enabled) => setForm((current) => ({ ...current, enabled }))} />
                <span>
                  <span className="block font-medium">{t('admin:customAgents.enabled')}</span>
                  <span className="block text-xs text-muted-foreground">{t('admin:customAgents.enabledHint')}</span>
                </span>
              </label>
            </div>
          </TabsContent>

          <TabsContent value="skills" className="m-0 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-5">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-border">
              <div className="shrink-0 border-b border-border p-3">
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{t('admin:customAgents.autoSkills')}</div>
                    <div className="text-xs leading-4 text-muted-foreground">{t('admin:customAgents.autoSkillsHint')}</div>
                  </div>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{t('admin:customAgents.selectedCount', { count: form.skillIds.length })}</span>
                </div>
                <div className="relative mt-3">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input className="pl-9" value={skillQuery} onChange={(event) => setSkillQuery(event.target.value)} placeholder={t('admin:customAgents.searchSkills')} />
                </div>
              </div>
              <div className="min-h-0 min-w-0 flex-1 divide-y divide-border overflow-y-auto overflow-x-hidden overscroll-contain">
                {visibleSkills.map((skill) => (
                  <label key={skill.id} className="flex w-full min-w-0 cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/40">
                    <Switch
                      className="shrink-0"
                      checked={form.skillIds.includes(skill.id)}
                      onCheckedChange={(checked) => setForm((current) => ({ ...current, skillIds: toggleItem(current.skillIds, skill.id, checked) }))}
                    />
                    <span className="min-w-0 flex-1 overflow-hidden">
                      <span className="block truncate text-sm font-medium">{skill.name}</span>
                      <span className="block truncate text-xs text-muted-foreground" title={skill.description || skill.id}>{skill.description || skill.id}</span>
                    </span>
                  </label>
                ))}
                {visibleSkills.length === 0 && <div className="p-8 text-center text-xs text-muted-foreground">{t('admin:customAgents.noSkills')}</div>}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="tools" className="m-0 flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-hidden p-5">
            <div className="flex shrink-0 flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/15 px-3 py-2.5">
              <div className="min-w-52 flex-1">
                <div className="text-xs font-semibold">{t('admin:customAgents.tools')}</div>
                <div className="text-[10px] leading-4 text-muted-foreground">
                  {form.toolNames === null
                    ? t('admin:customAgents.inheritToolsActive', { preset: selectedPreset?.label ?? form.baseAgentId })
                    : t('admin:customAgents.customToolsActive', { count: form.toolNames.length })}
                </div>
              </div>
              <label className="flex shrink-0 items-center gap-2 rounded-md bg-muted/60 px-2.5 py-1.5 text-xs">
                <Switch checked={form.toolNames !== null} onCheckedChange={setCustomToolMode} />
                {t('admin:customAgents.customizeTools')}
              </label>
            </div>

            <ToolAssignmentEditor
              className="min-h-0 flex-1"
              tools={form.toolNames === null ? inheritedTools : tools}
              selected={form.toolNames ?? inheritedToolNames}
              disabled={form.toolNames === null}
              mode={form.toolNames === null ? 'inherited' : 'allowlist'}
              inheritedTiers={form.toolNames === null ? inheritedToolTiers : []}
              baselineSelected={initial?.toolNames ?? inheritedToolNames}
              resetKind="saved"
              onChange={(toolNames) => setForm((current) => ({ ...current, toolNames }))}
            />
          </TabsContent>

          <TabsContent value="prompt" className="m-0 min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-5">
            <div className="mx-auto flex min-h-full max-w-3xl flex-col">
              <label className="text-sm font-medium">{t('admin:customAgents.prompt')}</label>
              <p className="mb-2 mt-1 text-xs leading-4 text-muted-foreground">{t('admin:customAgents.promptHint')}</p>
              <Textarea
                className="min-h-80 flex-1 resize-none font-mono text-xs"
                value={form.prompt}
                onChange={(event) => setForm((current) => ({ ...current, prompt: event.target.value }))}
                placeholder={t('admin:customAgents.promptPlaceholder')}
              />
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter className="shrink-0 border-t border-border px-5 py-3">
          <Button variant="outline" onClick={onClose}>{t('common:actions.cancel')}</Button>
          <Button disabled={!form.name.trim() || saving} onClick={() => void submit()}>
            {saving ? t('common:actions.saving') : t('common:actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
