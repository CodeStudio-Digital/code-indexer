import React, { useState } from 'react';
import { Plus, Trash2, Crown, Sparkles } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { apiPost, apiPatch, useApi } from '../../hooks/useApi.js';
import { useProviders } from '../../hooks/useProviders.js';

interface RoleConfig {
  role: string;
  provider: string;
  model: string;
  tier: 'bootstrap' | 'navigate' | 'full';
  systemPromptOverride?: string;
  /** Skill IDs enabled for this role. */
  skills?: string[];
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

export function TemplateBuilderModal({ onClose, onSaved, existingTemplate }: TemplateBuilderProps) {
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
  const [expandedSkills, setExpandedSkills] = useState<Set<number>>(new Set());

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

  function toggleSkill(roleIdx: number, skillId: string) {
    setRoles(roles.map((r, idx) => {
      if (idx !== roleIdx) return r;
      const current = r.skills ?? [];
      const next = current.includes(skillId)
        ? current.filter((s) => s !== skillId)
        : [...current, skillId];
      return { ...r, skills: next.length > 0 ? next : undefined };
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

  // Available skills (flatten from API response)
  const availableSkills: SkillDef[] = (skillsList as unknown as { commands: SkillDef[] })?.commands ?? [];

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-card rounded-lg border shadow-lg w-full max-w-2xl max-h-[85vh] overflow-y-auto">
        <div className="px-6 py-4 border-b">
          <h2 className="text-lg font-semibold">
            {existingTemplate ? 'Edit Template' : 'New Company Template'}
          </h2>
        </div>

        <div className="p-6 space-y-4">
          {/* Name & description */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full mt-1 rounded-md border bg-background px-3 py-1.5 text-sm"
                placeholder="Web Team"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Description</label>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full mt-1 rounded-md border bg-background px-3 py-1.5 text-sm"
                placeholder="Full-stack web development team"
              />
            </div>
          </div>

          {/* Roles */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-muted-foreground">Roles</label>
              <Button variant="outline" size="sm" onClick={addRole} className="h-7 text-xs">
                <Plus className="h-3 w-3 mr-1" /> Add Role
              </Button>
            </div>

            <div className="space-y-2">
              {roles.map((role, i) => {
                const models = getModelsForProvider(role.provider);
                const showSkills = expandedSkills.has(i);

                return (
                  <div key={i} className="rounded-md border p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      {role.role === 'master' && <Crown className="h-3.5 w-3.5 text-yellow-400 shrink-0" />}
                      <input
                        value={role.role}
                        onChange={(e) => updateRole(i, { role: e.target.value.toLowerCase().replace(/\s+/g, '_') })}
                        className="w-28 rounded border bg-background px-2 py-1 text-xs font-mono"
                        placeholder="role name"
                      />

                      {/* Provider picker — from admin config */}
                      <select
                        value={role.provider}
                        onChange={(e) => updateRole(i, { provider: e.target.value })}
                        className="rounded border bg-background px-2 py-1 text-xs"
                      >
                        {providerOptions.map((p) => (
                          <option key={p.id} value={p.id}>{p.label}</option>
                        ))}
                      </select>

                      {/* Model picker — dynamic from provider's model list */}
                      {models.length > 0 ? (
                        <select
                          value={role.model}
                          onChange={(e) => updateRole(i, { model: e.target.value })}
                          className="w-44 rounded border bg-background px-2 py-1 text-xs font-mono"
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
                          onChange={(e) => updateRole(i, { model: e.target.value })}
                          className="w-44 rounded border bg-background px-2 py-1 text-xs font-mono"
                          placeholder="model name"
                        />
                      )}

                      <select
                        value={role.tier}
                        onChange={(e) => updateRole(i, { tier: e.target.value as RoleConfig['tier'] })}
                        className="rounded border bg-background px-2 py-1 text-xs"
                      >
                        <option value="bootstrap">Bootstrap</option>
                        <option value="navigate">Navigate</option>
                        <option value="full">Full</option>
                      </select>

                      {/* Skills toggle button */}
                      {availableSkills.length > 0 && (
                        <button
                          onClick={() => setExpandedSkills((prev) => {
                            const next = new Set(prev);
                            if (next.has(i)) next.delete(i); else next.add(i);
                            return next;
                          })}
                          className="text-muted-foreground hover:text-foreground"
                          title="Configure skills for this role"
                        >
                          <Sparkles className="h-3.5 w-3.5" />
                        </button>
                      )}

                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive shrink-0"
                        onClick={() => removeRole(i)}
                        disabled={role.role === 'master' && roles.filter((r) => r.role === 'master').length <= 1}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>

                    {/* Skills config panel */}
                    {showSkills && availableSkills.length > 0 && (
                      <div className="border-t pt-2 mt-1">
                        <p className="text-[10px] text-muted-foreground mb-1.5">
                          Skills for {role.role || 'this role'}:
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {availableSkills.map((skill) => {
                            const active = role.skills?.includes(skill.id) ?? false;
                            return (
                              <button
                                key={skill.id}
                                onClick={() => toggleSkill(i, skill.id)}
                                className={`px-2 py-0.5 rounded-full text-[10px] border transition-colors ${
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

                    {/* System prompt override */}
                    <textarea
                      value={role.systemPromptOverride ?? ''}
                      onChange={(e) => updateRole(i, { systemPromptOverride: e.target.value || undefined })}
                      className="w-full rounded border bg-background px-2 py-1 text-xs font-mono resize-none"
                      placeholder="Custom system prompt override (optional)"
                      rows={2}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          {!roles.some((r) => r.role === 'master') && (
            <p className="text-xs text-destructive">At least one role must be named "master".</p>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} size="sm">Cancel</Button>
          <Button
            onClick={handleSave}
            disabled={saving || !name.trim() || !roles.some((r) => r.role === 'master')}
            size="sm"
          >
            {saving ? 'Saving...' : existingTemplate ? 'Update' : 'Create'}
          </Button>
        </div>
      </div>
    </div>
  );
}
