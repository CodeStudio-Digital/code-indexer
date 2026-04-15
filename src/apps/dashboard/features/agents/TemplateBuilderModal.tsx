import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, Crown, Sparkles, Pencil } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Textarea } from '../../components/ui/textarea.js';
import { Badge } from '../../components/ui/badge.js';
import { apiPost, apiPatch, useApi } from '../../hooks/useApi.js';
import { useProviders } from '../../hooks/useProviders.js';
import { FallbackPicker } from '../../components/FallbackPicker.js';
import { MarkdownToolbar } from '../chat/composer/MarkdownToolbar.js';
import { useMarkdownShortcuts } from '../chat/composer/useMarkdownShortcuts.js';

interface RoleConfig {
  role: string;
  provider: string;
  model: string;
  tier: 'bootstrap' | 'navigate' | 'full';
  systemPromptOverride?: string;
  /** Skill IDs enabled for this role. */
  skills?: string[];
  /** Fallback provider for auto-recovery. */
  fallback_provider?: string;
  /** Fallback model for auto-recovery. */
  fallback_model?: string;
}

interface SkillDef {
  id: string;
  name: string;
  description: string;
  context_mode: string;
  enabled: boolean;
}

interface TemplateBuilderProps {
  onClose: () => void;
  onSaved: () => void;
  existingTemplate?: {
    id: number;
    name: string;
    description: string;
    roles: RoleConfig[];
  };
}

// ─── RoleEditModal ────────────────────────────────────────────────────────────

interface RoleEditModalProps {
  role: RoleConfig;
  roleIdx: number;
  availableSkills: SkillDef[];
  providerOptions: Array<{ id: string; label: string }>;
  getModelsForProvider: (provider: string) => Array<{ id: string; name: string; mode?: string }>;
  onUpdate: (patch: Partial<RoleConfig>) => void;
  onClose: () => void;
}

function RoleEditModal({
  role,
  roleIdx,
  availableSkills,
  providerOptions,
  getModelsForProvider,
  onUpdate,
  onClose,
}: RoleEditModalProps) {
  const { t } = useTranslation(['agents', 'common']);
  const models = getModelsForProvider(role.provider);
  const [systemPrompt, setSystemPrompt] = useState(role.systemPromptOverride ?? '');
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const { handleKeyDown: mdKeyDown, applyAction } = useMarkdownShortcuts(promptRef, systemPrompt, (v) => {
    setSystemPrompt(v);
    onUpdate({ systemPromptOverride: v || undefined });
  });

  function handlePromptChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setSystemPrompt(e.target.value);
    onUpdate({ systemPromptOverride: e.target.value || undefined });
  }

  function toggleSkill(skillId: string) {
    const current = role.skills ?? [];
    const next = current.includes(skillId)
      ? current.filter((s) => s !== skillId)
      : [...current, skillId];
    onUpdate({ skills: next.length > 0 ? next : undefined });
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[60]">
      <div className="bg-card rounded-lg border shadow-lg w-full max-w-xl max-h-[85vh] flex flex-col">
        <div className="px-5 py-3.5 border-b flex items-center gap-2">
          {role.role === 'master' && <Crown className="h-4 w-4 text-yellow-400" />}
          <h3 className="text-sm font-semibold flex-1">
            Edit role: <span className="font-mono">{role.role || 'unnamed'}</span>
          </h3>
          <Button variant="ghost" size="sm" onClick={onClose} className="h-7 px-2 text-xs">{t('agents:role.done')}</Button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto flex-1">
          {/* Role name */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">{t('agents:role.name')}</label>
            <input
              value={role.role}
              onChange={(e) => onUpdate({ role: e.target.value.toLowerCase().replace(/\s+/g, '_') })}
              className="w-full rounded-md border bg-background px-3 py-1.5 text-sm font-mono"
              placeholder={t('agents:role.namePlaceholder')}
            />
          </div>

          {/* Provider + Model */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">{t('agents:role.provider')}</label>
              <select
                value={role.provider}
                onChange={(e) => onUpdate({ provider: e.target.value })}
                className="w-full rounded-md border bg-background px-3 py-1.5 text-sm"
              >
                {providerOptions.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">{t('agents:role.model')}</label>
              {models.length > 0 ? (
                <select
                  value={role.model}
                  onChange={(e) => onUpdate({ model: e.target.value })}
                  className="w-full rounded-md border bg-background px-3 py-1.5 text-sm font-mono"
                >
                  {models.map((m) => (
                    <option key={m.mode ? `${m.id}::${m.mode}` : m.id} value={m.id}>
                      {m.name}{m.mode ? ` (${m.mode})` : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={role.model}
                  onChange={(e) => onUpdate({ model: e.target.value })}
                  className="w-full rounded-md border bg-background px-3 py-1.5 text-sm font-mono"
                  placeholder="model-name"
                />
              )}
            </div>
          </div>

          {/* Fallback provider+model */}
          <FallbackPicker
            fallbackProvider={role.fallback_provider ?? null}
            fallbackModel={role.fallback_model ?? null}
            providerOptions={providerOptions}
            getModelsForProvider={getModelsForProvider}
            onChange={(p, m) => onUpdate({ fallback_provider: p ?? undefined, fallback_model: m ?? undefined })}
          />

          {/* Tier */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">{t('agents:role.tier')}</label>
            <select
              value={role.tier}
              onChange={(e) => onUpdate({ tier: e.target.value as RoleConfig['tier'] })}
              className="rounded-md border bg-background px-3 py-1.5 text-sm"
            >
              <option value="bootstrap">{t('agents:role.tierBootstrap')}</option>
              <option value="navigate">{t('agents:role.tierNavigate')}</option>
              <option value="full">{t('agents:role.tierFull')}</option>
            </select>
          </div>

          {/* Skills */}
          {availableSkills.length > 0 && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                <Sparkles className="h-3 w-3" /> {t('agents:role.skills')}
              </label>
              <div className="flex flex-wrap gap-1.5">
                {availableSkills.map((skill) => {
                  const active = role.skills?.includes(skill.id) ?? false;
                  return (
                    <button
                      key={skill.id}
                      onClick={() => toggleSkill(skill.id)}
                      className={`px-2 py-0.5 rounded-full text-[11px] border transition-colors ${
                        active
                          ? 'bg-primary/10 text-primary border-primary/30'
                          : 'bg-muted text-muted-foreground border-border hover:border-foreground/30'
                      }`}
                      title={skill.description}
                    >
                      /{skill.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* System prompt override — full markdown editor */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {t('agents:role.systemPrompt')}
              <span className="ml-1 text-[10px] font-normal opacity-60">{t('agents:role.systemPromptHint')}</span>
            </label>
            <div className="rounded-md border bg-background focus-within:ring-1 focus-within:ring-ring overflow-hidden">
              <Textarea
                ref={promptRef}
                value={systemPrompt}
                onChange={handlePromptChange}
                onKeyDown={mdKeyDown}
                placeholder={t('agents:role.systemPromptPlaceholder')}
                rows={12}
                className="font-mono text-xs border-0 focus-visible:ring-0 focus-visible:ring-offset-0 resize-y min-h-[200px] rounded-none"
              />
              <MarkdownToolbar onAction={applyAction} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── TemplateBuilderModal ─────────────────────────────────────────────────────

export function TemplateBuilderModal({ onClose, onSaved, existingTemplate }: TemplateBuilderProps) {
  const { t } = useTranslation(['agents', 'common']);
  const { providerOptions, getModelsForProvider, getDefaultModel } = useProviders();
  const { data: skillsList } = useApi<{ skills: SkillDef[] }>('/coder/skills/slash-commands');

  const [name, setName] = useState(existingTemplate?.name ?? '');
  const [description, setDescription] = useState(existingTemplate?.description ?? '');
  const [roles, setRoles] = useState<RoleConfig[]>(
    existingTemplate?.roles ?? [
      { role: 'master', provider: 'anthropic', model: 'claude-sonnet-4-6', tier: 'full' },
    ],
  );
  const [saving, setSaving] = useState(false);
  const [editingRoleIdx, setEditingRoleIdx] = useState<number | null>(null);

  function addRole() {
    const defaultProvider = providerOptions[0]?.id ?? 'anthropic';
    setRoles([...roles, {
      role: '',
      provider: defaultProvider,
      model: getDefaultModel(defaultProvider),
      tier: 'navigate',
    }]);
  }

  function removeRole(i: number) {
    if (roles[i].role === 'master' && roles.filter((r) => r.role === 'master').length <= 1) return;
    setRoles(roles.filter((_, idx) => idx !== i));
    if (editingRoleIdx === i) setEditingRoleIdx(null);
  }

  function updateRole(i: number, patch: Partial<RoleConfig>) {
    setRoles(roles.map((r, idx) => {
      if (idx !== i) return r;
      const updated = { ...r, ...patch };
      // Auto-update model when provider changes
      if (patch.provider && patch.provider !== r.provider) {
        updated.model = getDefaultModel(patch.provider);
      }
      return updated;
    }));
  }

  async function handleSave() {
    if (!name.trim() || roles.length === 0) return;
    if (!roles.some((r) => r.role === 'master')) return;

    setSaving(true);
    try {
      if (existingTemplate) {
        await apiPatch(`/company/templates/${existingTemplate.id}`, { name, description, roles });
      } else {
        await apiPost('/company/templates', { name, description, roles });
      }
      onSaved();
      onClose();
    } catch (e) {
      console.error('Failed to save template:', e);
    } finally {
      setSaving(false);
    }
  }

  const availableSkills: SkillDef[] = (skillsList as unknown as { commands: SkillDef[] })?.commands ?? [];

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-card rounded-lg border shadow-lg w-full max-w-2xl max-h-[85vh] overflow-y-auto">
        <div className="px-6 py-4 border-b">
          <h2 className="text-lg font-semibold">
            {existingTemplate ? t('agents:template.editTitle') : t('agents:template.newTitle')}
          </h2>
        </div>

        <div className="p-6 space-y-4">
          {/* Name & description */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">{t('agents:template.name')}</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full mt-1 rounded-md border bg-background px-3 py-1.5 text-sm"
                placeholder={t('agents:template.namePlaceholder')}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">{t('agents:template.description')}</label>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full mt-1 rounded-md border bg-background px-3 py-1.5 text-sm"
                placeholder={t('agents:template.descPlaceholder')}
              />
            </div>
          </div>

          {/* Roles list */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-muted-foreground">{t('agents:template.roles')}</label>
              <Button variant="outline" size="sm" onClick={addRole} className="h-7 text-xs">
                <Plus className="h-3 w-3 mr-1" /> {t('agents:template.addRole')}
              </Button>
            </div>

            <div className="space-y-1.5">
              {roles.map((role, i) => (
                <div key={i} className="flex items-center gap-2 rounded-md border px-3 py-2">
                  {role.role === 'master' && <Crown className="h-3.5 w-3.5 text-yellow-400 shrink-0" />}
                  <span className="text-sm font-mono flex-1 min-w-0 truncate">
                    {role.role || <em className="text-muted-foreground not-italic text-xs">{t('agents:template.unnamed')}</em>}
                  </span>
                  <span className="text-[11px] text-muted-foreground shrink-0 hidden sm:block">
                    {role.provider}/{role.model}
                  </span>
                  {(role.skills?.length ?? 0) > 0 && (
                    <Badge variant="outline" className="text-[10px] shrink-0">
                      <Sparkles className="h-2.5 w-2.5 mr-0.5" />{role.skills!.length}
                    </Badge>
                  )}
                  {role.systemPromptOverride && (
                    <Badge variant="outline" className="text-[10px] shrink-0 text-muted-foreground">{t('agents:template.customPrompt')}</Badge>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs shrink-0"
                    onClick={() => setEditingRoleIdx(i)}
                  >
                    <Pencil className="h-3 w-3 mr-1" /> {t('common:actions.edit')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive shrink-0"
                    onClick={() => removeRole(i)}
                    disabled={role.role === 'master' && roles.filter((r) => r.role === 'master').length <= 1}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          </div>

          {!roles.some((r) => r.role === 'master') && (
            <p className="text-xs text-destructive">{t('agents:template.masterRequired')}</p>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} size="sm">{t('common:actions.cancel')}</Button>
          <Button
            onClick={handleSave}
            disabled={saving || !name.trim() || !roles.some((r) => r.role === 'master')}
            size="sm"
          >
            {saving ? t('agents:template.saving') : existingTemplate ? t('agents:template.update') : t('common:actions.create')}
          </Button>
        </div>
      </div>

      {/* Per-role edit modal */}
      {editingRoleIdx !== null && roles[editingRoleIdx] && (
        <RoleEditModal
          role={roles[editingRoleIdx]}
          roleIdx={editingRoleIdx}
          availableSkills={availableSkills}
          providerOptions={providerOptions}
          getModelsForProvider={getModelsForProvider}
          onUpdate={(patch) => updateRole(editingRoleIdx, patch)}
          onClose={() => setEditingRoleIdx(null)}
        />
      )}
    </div>
  );
}
