import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, CheckCircle2, Crown, LayoutTemplate, Plus, Sparkles, Trash2, Pencil } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/badge.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { apiPost, apiPatch, useApi } from '../../hooks/useApi.js';
import { useProviders } from '../../hooks/useProviders.js';
import { RoleEditModal, type RoleConfig, type SkillDef } from './RoleEditModal.js';
import { withDefaultQaSkill } from '@mcp/company-contracts/qa-defaults.js';

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

// ─── TemplateBuilderModal ─────────────────────────────────────────────────────

export function TemplateBuilderModal({ onClose, onSaved, existingTemplate }: TemplateBuilderProps) {
  const { t } = useTranslation(['agents', 'common']);
  const { providerOptions, getModelsForProvider, getDefaultModel } = useProviders();
  const { data: skillsList } = useApi<{ skills: SkillDef[] }>('/admin/skills');

  const [name, setName] = useState(existingTemplate?.name ?? '');
  const [description, setDescription] = useState(existingTemplate?.description ?? '');
  const [roles, setRoles] = useState<RoleConfig[]>(
    existingTemplate?.roles ?? [
      { role: 'master', provider: 'anthropic', model: 'claude-sonnet-4-6', tier: 'full' },
    ],
  );
  const [saving, setSaving] = useState(false);
  const [editingRoleIdx, setEditingRoleIdx] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  function addRole() {
    const defaultProvider = providerOptions[0]?.id ?? 'anthropic';
    const nextRole: RoleConfig = {
      role: '',
      provider: defaultProvider,
      model: getDefaultModel(defaultProvider),
      tier: 'navigate',
    };
    setRoles([...roles, nextRole]);
    setEditingRoleIdx(roles.length);
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
    setError(null);
    try {
      if (existingTemplate) {
        await apiPatch(`/company/templates/${existingTemplate.id}`, { name, description, roles });
      } else {
        await apiPost('/company/templates', { name, description, roles: roles.map(withDefaultQaSkill) });
      }
      onSaved();
      onClose();
    } catch (e) {
      console.error('Failed to save template:', e);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const availableSkills: SkillDef[] = skillsList?.skills ?? [];

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[min(780px,90vh)] max-w-5xl flex-col gap-0 overflow-hidden border-[var(--workbench-border)] bg-[var(--workbench-surface)] p-0">
        <DialogHeader className="border-b border-[var(--workbench-border)] px-5 py-4 text-left">
          <div className="flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-md bg-violet-500/10 text-violet-400">
              <LayoutTemplate className="h-5 w-5" />
            </span>
            <span>
              <DialogTitle>{existingTemplate ? t('agents:template.editTitle') : t('agents:template.newTitle')}</DialogTitle>
              <DialogDescription className="mt-1">{t('agents:template.builderDescription')}</DialogDescription>
            </span>
          </div>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 md:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="min-h-0 overflow-y-auto border-r border-[var(--workbench-border)] bg-[var(--workbench-raised)] p-4">
            <div className="space-y-4">
              <div>
                <label className="text-[10px] font-medium text-muted-foreground">{t('agents:template.name')}</label>
                <input
                  autoFocus
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="mt-1 h-9 w-full rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-canvas)] px-3 text-sm outline-none focus:border-[var(--workbench-focus)]"
                  placeholder={t('agents:template.namePlaceholder')}
                />
              </div>
              <div>
                <label className="text-[10px] font-medium text-muted-foreground">{t('agents:template.description')}</label>
                <textarea
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  rows={4}
                  className="mt-1 w-full resize-none rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-canvas)] px-3 py-2 text-xs leading-5 outline-none focus:border-[var(--workbench-focus)]"
                  placeholder={t('agents:template.descPlaceholder')}
                />
              </div>

              <div className="rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-surface)] p-3">
                <h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t('agents:template.blueprintValidation')}</h3>
                <div className="mt-2 space-y-2">
                  <ValidationRow valid={name.trim().length > 0} label={t('agents:template.validation.identified')} />
                  <ValidationRow valid={roles.some((role) => role.role === 'master')} label={t('agents:template.validation.masterConfigured')} />
                  <ValidationRow valid={roles.every((role) => role.role.trim().length > 0)} label={t('agents:template.validation.rolesNamed')} />
                  <ValidationRow valid={roles.length > 1} label={t('agents:template.validation.specialistTeam')} optional />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <SummaryMetric label={t('agents:template.roles')} value={roles.length} />
                <SummaryMetric label={t('agents:role.skills')} value={roles.reduce((total, role) => total + (role.skills?.length ?? 0), 0)} />
                <SummaryMetric label={t('agents:template.providers')} value={new Set(roles.map((role) => role.provider)).size} />
              </div>
            </div>
          </aside>

          <section className="flex min-h-0 flex-col bg-[var(--workbench-canvas)]">
            <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--workbench-border)] px-4">
              <Bot className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs font-semibold">{t('agents:template.teamBlueprint')}</span>
              <span className="text-[10px] text-muted-foreground">{t('agents:template.roleCount', { count: roles.length })}</span>
              <Button variant="outline" size="sm" onClick={addRole} className="ml-auto h-7 gap-1 text-[10px]">
                <Plus className="h-3 w-3" /> {t('agents:template.addRole')}
              </Button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <div className="mx-auto max-w-2xl space-y-2">
                {roles.map((role, index) => {
                  const isMaster = role.role === 'master';
                  return (
                    <div
                      key={index}
                      className={`group rounded-lg border bg-[var(--workbench-surface)] transition-colors ${
                        isMaster ? 'border-amber-500/30' : 'border-[var(--workbench-border)] hover:border-violet-500/30'
                      }`}
                    >
                      <div className="flex items-start gap-3 p-3">
                        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-md ${
                          isMaster ? 'bg-amber-500/10 text-amber-400' : 'bg-violet-500/8 text-violet-400'
                        }`}>
                          {isMaster ? <Crown className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="truncate font-mono text-xs font-semibold text-foreground">
                              {role.role || <em className="font-sans font-normal text-muted-foreground">{t('agents:template.unnamed')}</em>}
                            </span>
                            <Badge variant="outline" className="h-4 px-1 text-[8px] font-normal">{role.tier}</Badge>
                          </span>
                          <span className="mt-1 block truncate font-mono text-[9px] text-muted-foreground">{role.provider}/{role.model}</span>
                          <span className="mt-2 flex flex-wrap gap-1">
                            {(role.skills?.length ?? 0) > 0 && (
                              <Badge variant="outline" className="h-4 gap-0.5 px-1 text-[8px] font-normal">
                                <Sparkles className="h-2 w-2" /> {t('agents:template.skillCount', { count: role.skills!.length })}
                              </Badge>
                            )}
                            {role.systemPromptOverride && (
                              <Badge variant="outline" className="h-4 px-1 text-[8px] font-normal">{t('agents:template.customPrompt')}</Badge>
                            )}
                            {role.fallback_model && (
                              <Badge variant="outline" className="h-4 px-1 text-[8px] font-normal">{t('agents:template.fallbackConfigured')}</Badge>
                            )}
                          </span>
                        </span>
                        <span className="flex items-center gap-1 opacity-70 transition-opacity group-hover:opacity-100">
                          <Button variant="outline" size="sm" className="h-7 gap-1 px-2 text-[10px]" onClick={() => setEditingRoleIdx(index)}>
                            <Pencil className="h-3 w-3" /> {t('common:actions.edit')}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            onClick={() => removeRole(index)}
                            disabled={isMaster && roles.filter((item) => item.role === 'master').length <= 1}
                            aria-label={t('agents:template.removeRoleLabel', { role: role.role || t('agents:template.role') })}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </span>
                      </div>
                    </div>
                  );
                })}

                <button
                  type="button"
                  onClick={addRole}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--workbench-border)] py-4 text-[11px] text-muted-foreground transition-colors hover:border-violet-500/40 hover:bg-violet-500/5 hover:text-foreground"
                >
                  <Plus className="h-3.5 w-3.5" /> {t('agents:template.addSpecialist')}
                </button>

                {!roles.some((role) => role.role === 'master') && (
                  <p className="rounded border border-destructive/30 bg-destructive/8 px-3 py-2 text-[10px] text-destructive">{t('agents:template.masterRequired')}</p>
                )}
                {error && (
                  <p className="rounded border border-destructive/30 bg-destructive/8 px-3 py-2 text-[10px] text-destructive">{error}</p>
                )}
              </div>
            </div>
          </section>
        </div>

        <DialogFooter className="flex-row items-center border-t border-[var(--workbench-border)] bg-[var(--workbench-raised)] px-5 py-3 sm:justify-between">
          <span className="hidden text-[10px] text-muted-foreground sm:block">{t('agents:template.saveChangesHint')}</span>
          <div className="ml-auto flex gap-2">
            <Button variant="outline" onClick={onClose} size="sm">{t('common:actions.cancel')}</Button>
            <Button
              onClick={handleSave}
              disabled={saving || !name.trim() || !roles.some((role) => role.role === 'master') || roles.some((role) => !role.role.trim())}
              size="sm"
            >
              {saving ? t('agents:template.saving') : existingTemplate ? t('agents:template.update') : t('common:actions.create')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>

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
          inheritedToolTiers={[
            'company',
            ...(roles[editingRoleIdx].role === 'qa' || roles[editingRoleIdx].skills?.some((skill) => skill === 'qa-playwright' || skill === 'qa-preview') ? ['qa'] : []),
            ...(['qa', 'frontend', 'ux', 'fullstack'].includes(roles[editingRoleIdx].role) ? ['preview'] : []),
            ...(roles[editingRoleIdx].role === 'database' ? ['db'] : []),
          ]}
        />
      )}
    </Dialog>
  );
}

function ValidationRow({ valid, label, optional = false }: { valid: boolean; label: string; optional?: boolean }) {
  const { t } = useTranslation('agents');
  return (
    <div className="flex items-center gap-2 text-[10px]">
      <CheckCircle2 className={`h-3.5 w-3.5 ${valid ? 'text-emerald-400' : 'text-muted-foreground/40'}`} />
      <span className={valid ? 'text-foreground' : 'text-muted-foreground'}>{label}</span>
      {optional && <span className="ml-auto text-[8px] text-muted-foreground">{t('template.optional')}</span>}
    </div>
  );
}

function SummaryMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-surface)] px-2 py-2 text-center">
      <span className="block text-sm font-semibold tabular-nums text-foreground">{value}</span>
      <span className="block text-[8px] text-muted-foreground">{label}</span>
    </div>
  );
}
