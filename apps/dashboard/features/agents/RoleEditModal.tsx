import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Crown, MessageSquareText, Server, Settings2, Wrench } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Textarea } from '../../components/ui/textarea.js';
import { Badge } from '../../components/ui/badge.js';
import { Dialog, DialogContent } from '../../components/ui/dialog.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { FallbackPicker } from '../../components/FallbackPicker.js';
import { MarkdownToolbar } from '../chat/composer/MarkdownToolbar.js';
import { useMarkdownShortcuts } from '../chat/composer/useMarkdownShortcuts.js';
import { useAdminMcpServers } from '../admin/hooks/useAdminMcpServers.js';
import { fetchToolConfigs, type ToolConfigItem } from '../admin/tools-api.js';
import {
  AgentRuntimeFields,
  SkillAssignmentEditor,
  ToolAssignmentEditor,
  type SkillAssignmentOption,
} from '../../components/agent-config/index.js';

export interface RoleConfig {
  role: string;
  provider: string;
  model: string;
  tier: 'bootstrap' | 'navigate' | 'full';
  systemPromptOverride?: string;
  /** Skill IDs enabled for this role. */
  skills?: string[];
  /** Tools pinned into the visible catalog when this role starts. */
  initialTools?: string[];
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
  /** Canonical App roles cannot be renamed from the contextual rail. */
  roleNameReadOnly?: boolean;
  /** Capability tiers granted by the role/preset outside the core profile. */
  inheritedToolTiers?: string[];
  /** Static role/runtime catalog boundary used to hide impossible pins. */
  availableToolNames?: string[];
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
  roleNameReadOnly = false,
  inheritedToolTiers = [],
  availableToolNames,
}: RoleEditModalProps) {
  const { t } = useTranslation(['agents', 'common']);
  const { servers: mcpServers } = useAdminMcpServers();
  const enabledMcpServers = mcpServers.filter((s) => s.enabled);
  const isMasterRole = role.role === 'master';
  const [systemPrompt, setSystemPrompt] = useState(role.systemPromptOverride ?? '');
  const [availableTools, setAvailableTools] = useState<ToolConfigItem[]>([]);
  const [toolsLoading, setToolsLoading] = useState(true);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const { handleKeyDown: mdKeyDown, applyAction } = useMarkdownShortcuts(promptRef, systemPrompt, (v) => {
    setSystemPrompt(v);
    onUpdate({ systemPromptOverride: v || undefined });
  });

  function handlePromptChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setSystemPrompt(e.target.value);
    onUpdate({ systemPromptOverride: e.target.value || undefined });
  }

  useEffect(() => {
    let active = true;
    setToolsLoading(true);
    void fetchToolConfigs()
      .then((tools) => { if (active) setAvailableTools(tools); })
      .catch(() => { if (active) setAvailableTools([]); })
      .finally(() => { if (active) setToolsLoading(false); });
    return () => { active = false; };
  }, []);

  const effectiveInheritedToolTiers = [...new Set([
    'bootstrap',
    ...(role.tier === 'navigate' || role.tier === 'full' ? ['navigate'] : []),
    ...(role.tier === 'full' ? ['admin'] : []),
    ...(isMasterRole ? ['master'] : []),
    ...inheritedToolTiers,
  ])];
  const pinnedToolNames = new Set(role.initialTools ?? []);
  const allowedToolNames = availableToolNames ? new Set(availableToolNames) : null;
  const contextualTools = availableTools.filter((tool) => {
    if (pinnedToolNames.has(tool.name)) return true;
    if (tool.source === 'mcp_external') return true;
    if (!effectiveInheritedToolTiers.includes(tool.tier)) return false;
    return allowedToolNames === null || allowedToolNames.has(tool.name);
  });

  return (
    <Dialog open onOpenChange={(open) => { if (!open) (onCancel ?? onClose)(); }}>
      <DialogContent
        aria-labelledby="role-edit-title"
        className="grid h-[min(800px,90vh)] w-[min(980px,calc(100vw-2rem))] min-w-0 max-w-[980px] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-xl p-0 shadow-2xl"
      >
        <header className="flex min-w-0 items-center gap-3 border-b px-5 py-4">
          {role.role === 'master' && <Crown className="h-4 w-4 text-yellow-400" />}
          <div className="min-w-0 flex-1">
            <h3 id="role-edit-title" className="truncate text-sm font-semibold">
              {t('agents:role.editTitle', { role: role.role || t('agents:role.unnamed') })}
            </h3>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{t('agents:role.dialogHint')}</p>
          </div>
        </header>

        <Tabs defaultValue="general" className="flex min-h-0 min-w-0 flex-col overflow-hidden">
          <TabsList className="mx-5 mt-4 grid h-9 w-auto shrink-0 grid-cols-3 p-0.5">
            <TabsTrigger value="general" className="h-8 text-xs">
              <Settings2 /> {t('agents:role.tabs.general')}
            </TabsTrigger>
            <TabsTrigger value="capabilities" className="h-8 text-xs">
              <Wrench /> {t('agents:role.tabs.capabilities')} ({role.initialTools?.length ?? 0})
            </TabsTrigger>
            <TabsTrigger value="prompt" className="h-8 text-xs">
              <MessageSquareText /> {t('agents:role.tabs.prompt')}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="general" className="m-0 min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-5">
            <div className="mx-auto max-w-3xl space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">{t('agents:role.name')}</label>
                <input
                  value={role.role}
                  disabled={roleNameReadOnly}
                  onChange={(e) => onUpdate({ role: e.target.value.toLowerCase().replace(/\s+/g, '_') })}
                  className="w-full rounded-md border bg-background px-3 py-1.5 font-mono text-sm disabled:cursor-not-allowed disabled:opacity-60"
                  placeholder={t('agents:role.namePlaceholder')}
                />
              </div>

              <AgentRuntimeFields
                value={{ provider: role.provider, model: role.model, reasoningEffort: role.reasoningEffort }}
                providerOptions={providerOptions}
                getModelsForProvider={getModelsForProvider}
                onChange={(patch) => onUpdate(patch)}
              />

              <FallbackPicker
                fallbackProvider={role.fallback_provider ?? null}
                fallbackModel={role.fallback_model ?? null}
                providerOptions={providerOptions}
                getModelsForProvider={getModelsForProvider}
                onChange={(p, m) => onUpdate({ fallback_provider: p ?? undefined, fallback_model: m ?? undefined })}
              />

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
                  className="w-40 rounded-md border bg-background px-3 py-1.5 font-mono text-sm"
                />
              </div>

              <div className={`rounded-md border bg-card transition-colors ${role.thinking ? 'border-primary/30 bg-primary/[0.03]' : 'border-border'}`}>
                <label className="flex cursor-pointer select-none items-start gap-2.5 p-3">
                  <input
                    type="checkbox"
                    checked={!!role.thinking}
                    onChange={(e) => onUpdate({
                      thinking: e.target.checked || undefined,
                      ...(e.target.checked ? {} : { thinkingBudgetTokens: undefined }),
                    })}
                    className="mt-0.5 h-3.5 w-3.5 accent-primary"
                  />
                  <span className="flex-1 text-xs leading-snug">
                    <span className="font-medium text-foreground">{t('agents:role.thinking.title')}</span>
                    <span className="mt-0.5 block text-muted-foreground">{t('agents:role.thinking.description')}</span>
                  </span>
                </label>
                {role.thinking && (
                  <div className="flex items-center gap-2 border-t border-border/60 px-3 py-2">
                    <label className="shrink-0 text-[11px] text-muted-foreground">{t('agents:role.thinking.budgetLabel')}</label>
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
                      className="h-7 w-28 rounded-md border bg-background px-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    <span className="ml-auto text-[10px] tabular-nums text-muted-foreground/80">{t('agents:role.thinking.anthropicOnly')}</span>
                  </div>
                )}
              </div>

              <div className="rounded-lg border border-border p-3">
                <SkillAssignmentEditor
                  compact
                  skills={availableSkills}
                  selected={role.skills ?? []}
                  onChange={(skills) => onUpdate({ skills: skills.length > 0 ? skills : undefined })}
                />
              </div>

              {!isMasterRole && enabledMcpServers.length > 0 && (
                <div className="space-y-1.5 rounded-lg border border-border p-3">
                  <label className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                    <Server className="h-3 w-3" /> {t('agents:role.availableMcps')}
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {enabledMcpServers.map((s) => (
                      <Badge key={s.id} variant="outline" className="h-5 font-mono text-[10px]" title={s.name}>{s.id}</Badge>
                    ))}
                  </div>
                  <p className="text-[10px] text-muted-foreground opacity-80">{t('agents:role.availableMcpsHint')}</p>
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="capabilities" className="m-0 flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-hidden p-5">
            <div className="flex shrink-0 flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/15 px-3 py-2.5">
              <div className="min-w-44 flex-1">
                <div className="text-xs font-semibold">{t('agents:role.capabilityProfile')}</div>
                <p className="text-[10px] leading-4 text-muted-foreground">{t('agents:role.capabilityProfileHint')}</p>
              </div>
              <select
                value={role.tier}
                onChange={(e) => onUpdate({ tier: e.target.value as RoleConfig['tier'] })}
                className="h-8 rounded-md border bg-background px-3 text-xs"
              >
                <option value="bootstrap">{t('agents:role.tierBootstrap')}</option>
                <option value="navigate">{t('agents:role.tierNavigate')}</option>
                <option value="full">{t('agents:role.tierFull')}</option>
              </select>
              <div className="flex max-w-full flex-wrap items-center gap-1">
                <span className="text-[9px] text-muted-foreground">{t('agents:role.inheritedTiers')}</span>
                {effectiveInheritedToolTiers.map((tier) => <Badge key={tier} variant="outline" className="h-5 text-[9px] uppercase">{tier}</Badge>)}
              </div>
            </div>

            <ToolAssignmentEditor
              className="min-h-0 flex-1"
              tools={contextualTools}
              selected={role.initialTools ?? []}
              loading={toolsLoading}
              inheritedTiers={effectiveInheritedToolTiers}
              onChange={(initialTools) => onUpdate({ initialTools: initialTools.length > 0 ? initialTools : undefined })}
            />
          </TabsContent>

          <TabsContent value="prompt" className="m-0 min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-5">
            <div className="mx-auto flex min-h-full max-w-3xl flex-col">
              <label className="text-xs font-medium text-muted-foreground">
                {t('agents:role.systemPrompt')}
                <span className="ml-1 text-[10px] font-normal opacity-60">{t('agents:role.systemPromptHint')}</span>
              </label>
              <p className="mb-2 mt-1 text-[10px] leading-4 text-muted-foreground">{t('agents:role.promptTabHint')}</p>
              <div className="flex min-h-80 flex-1 flex-col overflow-hidden rounded-md border bg-background focus-within:ring-1 focus-within:ring-ring">
                <Textarea
                  ref={promptRef}
                  value={systemPrompt}
                  onChange={handlePromptChange}
                  onKeyDown={mdKeyDown}
                  placeholder={t('agents:role.systemPromptPlaceholder')}
                  className="min-h-0 flex-1 resize-none rounded-none border-0 font-mono text-xs focus-visible:ring-0 focus-visible:ring-offset-0"
                />
                <MarkdownToolbar onAction={applyAction} />
              </div>
            </div>
          </TabsContent>
        </Tabs>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t px-5 py-3">
          {onCancel && (
            <Button variant="outline" size="sm" onClick={onCancel}>{t('common:actions.cancel')}</Button>
          )}
          <Button size="sm" onClick={onClose}>{t('agents:role.done')}</Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
