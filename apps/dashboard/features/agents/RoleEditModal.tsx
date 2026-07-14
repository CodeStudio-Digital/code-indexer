import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Crown, Server } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Textarea } from '../../components/ui/textarea.js';
import { Badge } from '../../components/ui/badge.js';
import { FallbackPicker } from '../../components/FallbackPicker.js';
import { MarkdownToolbar } from '../chat/composer/MarkdownToolbar.js';
import { useMarkdownShortcuts } from '../chat/composer/useMarkdownShortcuts.js';
import { useAdminMcpServers } from '../admin/hooks/useAdminMcpServers.js';
import { AgentRuntimeFields, SkillAssignmentEditor, type SkillAssignmentOption } from '../../components/agent-config/index.js';

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
  /**
   * Per-role sticky reasoning-effort override (e.g. `minimal`/`low`/`medium`/
   * `high`/`xhigh`). Orthogonal to `thinking`. Only meaningful when this role's
   * model exposes discrete effort levels; the selector is hidden otherwise.
   * Undefined → model default.
   */
  reasoningEffort?: string;
  /**
   * Phase E: when true, subordinates spawned with this role run with
   * extended thinking (deep reasoning) on providers that support it.
   */
  thinking?: boolean;
  /**
   * Phase E: Anthropic-specific thinking budget (defaults to ~5000 when
   * undefined). Ignored by providers that don't support it.
   */
  thinkingBudgetTokens?: number;
}

export type SkillDef = SkillAssignmentOption & { enabled: boolean; source: 'user' | 'builtin' | 'imported' };

interface RoleEditModalProps {
  role: RoleConfig;
  roleIdx: number;
  availableSkills: SkillDef[];
  providerOptions: Array<{ id: string; label: string }>;
  getModelsForProvider: (
    provider: string,
  ) => Array<{ id: string; name: string; mode?: string; supported_reasoning_levels?: string[] | null }>;
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
  const { servers: mcpServers } = useAdminMcpServers();
  const enabledMcpServers = mcpServers.filter((s) => s.enabled);
  const isMasterRole = role.role === 'master';
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

          <AgentRuntimeFields
            value={{ provider: role.provider, model: role.model, reasoningEffort: role.reasoningEffort }}
            providerOptions={providerOptions}
            getModelsForProvider={getModelsForProvider}
            onChange={(patch) => onUpdate(patch)}
          />

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

          {/* Extended thinking — Phase E */}
          <div
            className={`rounded-md border bg-card transition-colors ${
              role.thinking ? 'border-primary/30 bg-primary/[0.03]' : 'border-border'
            }`}
          >
            <label className="flex items-start gap-2.5 p-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={!!role.thinking}
                onChange={(e) =>
                  onUpdate({
                    thinking: e.target.checked || undefined,
                    // Drop the budget when thinking is off so we don't
                    // ship a stale number through the next save.
                    ...(e.target.checked ? {} : { thinkingBudgetTokens: undefined }),
                  })
                }
                className="mt-0.5 h-3.5 w-3.5 accent-primary"
              />
              <span className="flex-1 text-xs leading-snug">
                <span className="font-medium text-foreground">
                  {t('agents:role.thinking.title')}
                </span>
                <span className="block text-muted-foreground mt-0.5">
                  {t('agents:role.thinking.description')}
                </span>
              </span>
            </label>
            {role.thinking && (
              <div className="flex items-center gap-2 border-t border-border/60 px-3 py-2">
                <label className="text-[11px] text-muted-foreground shrink-0">
                  {t('agents:role.thinking.budgetLabel')}
                </label>
                <input
                  type="number"
                  min={1024}
                  step={1024}
                  value={role.thinkingBudgetTokens ?? ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === '') {
                      onUpdate({ thinkingBudgetTokens: undefined });
                      return;
                    }
                    const parsed = parseInt(v, 10);
                    if (!Number.isFinite(parsed) || parsed < 0) return;
                    onUpdate({ thinkingBudgetTokens: parsed });
                  }}
                  placeholder={t('agents:role.thinking.budgetPlaceholder')}
                  className="h-7 w-28 rounded-md border bg-background px-2 text-xs font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <span className="ml-auto text-[10px] text-muted-foreground/80 tabular-nums">
                  {t('agents:role.thinking.anthropicOnly')}
                </span>
              </div>
            )}
          </div>

          <SkillAssignmentEditor skills={availableSkills} selected={role.skills ?? []} onChange={(skills) => onUpdate({ skills: skills.length > 0 ? skills : undefined })} />

          {/* Available MCP packs — read-only. Subordinates auto-receive every
              enabled server as an opt-in custom tier (named by server id) and
              unlock it on demand via expand_toolset. Master path is unchanged. */}
          {!isMasterRole && enabledMcpServers.length > 0 && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                <Server className="h-3 w-3" /> {t('agents:role.availableMcps')}
              </label>
              <div className="flex flex-wrap gap-1.5">
                {enabledMcpServers.map((s) => (
                  <Badge key={s.id} variant="outline" className="text-[10px] h-5 font-mono" title={s.name}>
                    {s.id}
                  </Badge>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground opacity-80">
                {t('agents:role.availableMcpsHint')}
              </p>
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
