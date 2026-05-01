import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Crown, Sparkles } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Textarea } from '../../components/ui/textarea.js';
import { Badge } from '../../components/ui/badge.js';
import { FallbackPicker } from '../../components/FallbackPicker.js';
import { MarkdownToolbar } from '../chat/composer/MarkdownToolbar.js';
import { useMarkdownShortcuts } from '../chat/composer/useMarkdownShortcuts.js';

export interface RoleConfig {
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
  /** Sampling temperature override for this role (range [0, 1]). */
  temperature?: number;
}

export interface SkillDef {
  id: string;
  name: string;
  description: string;
  context_mode: string;
  enabled: boolean;
  slash_command: string | null;
  author?: string | null;
  source?: 'user' | 'builtin' | 'imported';
}

interface RoleEditModalProps {
  role: RoleConfig;
  roleIdx: number;
  availableSkills: SkillDef[];
  providerOptions: Array<{ id: string; label: string }>;
  getModelsForProvider: (provider: string) => Array<{ id: string; name: string; mode?: string }>;
  onUpdate: (patch: Partial<RoleConfig>) => void;
  onClose: () => void;
  /**
   * When provided, renders a Cancel button alongside Done. Use this when
   * closing commits a change (e.g. create-new-role on a running session):
   * Done confirms, Cancel dismisses without committing.
   */
  onCancel?: () => void;
}

export function RoleEditModal({
  role,
  roleIdx,
  availableSkills,
  providerOptions,
  getModelsForProvider,
  onUpdate,
  onClose,
  onCancel,
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
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-[60]"
      onClick={() => (onCancel ?? onClose)()}
    >
      <div
        className="bg-card rounded-lg border shadow-lg w-full max-w-xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3.5 border-b flex items-center gap-2">
          {role.role === 'master' && <Crown className="h-4 w-4 text-yellow-400" />}
          <h3 className="text-sm font-semibold flex-1">
            Edit role: <span className="font-mono">{role.role || 'unnamed'}</span>
          </h3>
          {onCancel && (
            <Button variant="ghost" size="sm" onClick={onCancel} className="h-7 px-2 text-xs">
              {t('common:actions.cancel')}
            </Button>
          )}
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

          {/* Temperature */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {t('agents:role.temperature', { defaultValue: 'Temperature' })}
            </label>
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={role.temperature ?? ''}
              onChange={(e) => {
                const v = e.target.value;
                if (v === '') {
                  onUpdate({ temperature: undefined });
                  return;
                }
                const parsed = parseFloat(v);
                if (!Number.isFinite(parsed)) return;
                onUpdate({ temperature: Math.min(1, Math.max(0, parsed)) });
              }}
              placeholder={t('agents:role.temperaturePlaceholder', { defaultValue: 'auto (by agent preset)' })}
              className="rounded-md border bg-background px-3 py-1.5 text-sm font-mono w-32"
            />
          </div>

          {/* Skills — grouped by author/namespace */}
          {availableSkills.length > 0 && (() => {
            const groups = new Map<string, SkillDef[]>();
            for (const s of availableSkills) {
              const key =
                s.source === 'imported' && s.author
                  ? s.author
                  : s.source === 'builtin'
                    ? 'builtin'
                    : 'user';
              const arr = groups.get(key) ?? [];
              arr.push(s);
              groups.set(key, arr);
            }
            const order = ['user', 'builtin', ...Array.from(groups.keys()).filter((k) => k !== 'user' && k !== 'builtin').sort()];
            return (
              <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                  <Sparkles className="h-3 w-3" /> {t('agents:role.skills')}
                </label>
                {order.filter((k) => groups.has(k)).map((key) => (
                  <div key={key} className="space-y-1">
                    <div className="flex items-center gap-1.5">
                      <Badge variant="outline" className="text-[10px] h-4">
                        {key}
                      </Badge>
                      <span className="text-[10px] text-muted-foreground">
                        {(groups.get(key) ?? []).length}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {(groups.get(key) ?? []).map((skill) => {
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
                            {skill.slash_command ? `/${skill.slash_command}` : skill.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}

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
