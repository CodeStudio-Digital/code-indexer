/**
 * Shared "model settings" dialog — provider / model / max-turns / temperature /
 * reasoning-effort / plan-depth / fallback (and optionally the agent picker)
 * collapsed behind one dialog. Used by BOTH the full chat composer
 * (`ComposerToolbar` via `Composer`) and the compact editor rail
 * (`RailComposerBar`) so the controls live in exactly one place.
 *
 * The trigger lives in the caller (a text chip showing the active
 * provider · model); this component owns only the dialog body. State is the
 * same per-session state threaded down from AgentChat, so changes apply
 * immediately to the next turn.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BookOpen, Gauge, Languages, Layers, Repeat, Sparkles, Thermometer } from 'lucide-react';
import { Input } from '../../../components/ui/input.js';
import { Combobox, type ComboboxOption } from '../../../components/ui/combobox.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../../components/ui/dialog.js';
import { Switch } from '../../../components/ui/switch.js';
import { FallbackPicker } from '../../../components/FallbackPicker.js';
import { PROVIDERS } from '../constants.js';
import type { EnrichedProviderModel, ExecutionMode, ProviderOption } from '../types.js';
import { AgentPicker } from './AgentPicker.js';
import type { AgentPreset } from '@mcp/api-bus';

type AgentId = AgentPreset;

/**
 * Build the trigger label: "Provider · model", or the empty-state text when no
 * model is selected. `model` may carry a "::mode" suffix — only the id shows.
 */
export function modelSettingsLabel(
  providerOptions: ProviderOption[],
  provider: string,
  model: string,
  emptyText: string,
): string {
  if (!model) return emptyText;
  const providerLabel = providerOptions.find((p) => p.id === provider)?.label ?? provider;
  const modelLabel = model.includes('::') ? model.split('::')[0] : model;
  return `${providerLabel} · ${modelLabel}`;
}

export function fixedTemperatureForModel(model: string): number | null {
  const modelId = model.includes('::') ? model.split('::')[0] : model;
  return modelId.trim().toLowerCase() === 'k3' ? 1 : null;
}

interface ModelSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Render the agent picker inside the dialog. The full composer keeps the
   *  agent inline (so passes false); the rail collapses it here. */
  showAgent?: boolean;
  agent: AgentId;
  setAgent: (v: AgentId) => void;
  autoSuggestText: string;
  provider: string;
  model: string;
  setModel: (v: string) => void;
  onSwitchProvider: (p: string, m: string) => void;
  providerOptions: ProviderOption[];
  currentProviderModels: EnrichedProviderModel[];
  maxTurns: number | null;
  setMaxTurns: (v: number | null) => void;
  maxAutoContinues: number;
  setMaxAutoContinues: (v: number) => void;
  temperature: number | null;
  setTemperature: (v: number | null) => void;
  reasoningEffort?: string | null;
  setReasoningEffort?: (v: string | null) => void;
  reasoningLevels?: string[];
  executionMode?: ExecutionMode;
  setExecutionMode?: (v: ExecutionMode) => void;
  executionModePending?: boolean;
  executionModeLocked?: boolean;
  planDepth?: string | null;
  setPlanDepth?: (v: string | null) => void;
  /** Per-session response language (migration 177). null/'' → auto (user's language). */
  responseLanguage?: string | null;
  setResponseLanguage?: (v: string | null) => void;
  /** Per-session output style (migration 178): proactive | explanatory | learning. */
  outputStyle?: string | null;
  setOutputStyle?: (v: string | null) => void;
  fallbackProvider: string | null;
  fallbackModel: string | null;
  onFallbackChange: (provider: string | null, model: string | null) => void;
  getModelsForProvider: (providerId: string) => EnrichedProviderModel[];
}

export function ModelSettingsDialog({
  open,
  onOpenChange,
  ...contentProps
}: ModelSettingsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <ModelSettingsDialogBody {...contentProps} />
      </DialogContent>
    </Dialog>
  );
}

function ModelSettingsDialogBody({
  showAgent = true,
  agent,
  setAgent,
  autoSuggestText,
  provider,
  model,
  setModel,
  onSwitchProvider,
  providerOptions,
  currentProviderModels,
  maxTurns,
  setMaxTurns,
  maxAutoContinues,
  setMaxAutoContinues,
  temperature,
  setTemperature,
  reasoningEffort,
  setReasoningEffort,
  reasoningLevels,
  executionMode = 'standard',
  setExecutionMode,
  executionModePending = false,
  executionModeLocked = false,
  planDepth,
  setPlanDepth,
  responseLanguage,
  setResponseLanguage,
  outputStyle,
  setOutputStyle,
  fallbackProvider,
  fallbackModel,
  onFallbackChange,
  getModelsForProvider,
}: Omit<ModelSettingsDialogProps, 'open' | 'onOpenChange'>) {
  const { t } = useTranslation(['chat', 'common']);
  const fixedTemperature = fixedTemperatureForModel(model);
  const [turnLimitEnabled, setTurnLimitEnabled] = useState(maxTurns !== null);
  useEffect(() => {
    setTurnLimitEnabled(maxTurns !== null);
  }, [maxTurns]);
  const providerComboboxOptions = useMemo(
    () => providerOptions.map((p) => ({ value: p.id, label: p.label })),
    [providerOptions],
  );
  const modelComboboxOptions = useMemo(
    () => currentProviderModels.map<ComboboxOption>((m) => ({
      value: m.mode ? `${m.id}::${m.mode}` : m.id,
      label: m.id,
      hint: m.mode,
    })),
    [currentProviderModels],
  );

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('chat:toolbar.modelSettings')}</DialogTitle>
      </DialogHeader>
      <div className="space-y-3">
          {showAgent && (
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">{t('chat:toolbar.agent', { defaultValue: 'Agent' })}</label>
              <AgentPicker value={agent} onChange={setAgent} autoSuggestFor={autoSuggestText} />
            </div>
          )}
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">{t('chat:toolbar.provider')}</label>
            <Combobox
              value={provider}
              onChange={(v) => onSwitchProvider(v, '')}
              options={providerComboboxOptions}
              placeholder={t('chat:toolbar.provider')}
              searchPlaceholder={t('chat:toolbar.searchProvider')}
              emptyLabel={t('chat:toolbar.noProvider')}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">{t('chat:toolbar.model')}</label>
            {currentProviderModels.length > 0 ? (
              <Combobox
                value={model}
                onChange={(v) => { setModel(v); onSwitchProvider(provider, v); }}
                options={modelComboboxOptions}
                placeholder={t('chat:toolbar.defaultModel')}
                searchPlaceholder={t('chat:toolbar.searchModel')}
                emptyLabel={t('chat:toolbar.noModel')}
              />
            ) : (
              <Input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                onBlur={(e) => onSwitchProvider(provider, e.target.value)}
                placeholder={PROVIDERS.find((p) => p.id === provider)?.defaultModel}
                className="h-8 text-xs font-mono"
              />
            )}
          </div>
          {setExecutionMode && (
            <div
              className={`rounded-lg border p-3 transition-colors ${
                executionMode === 'ultra'
                  ? 'border-violet-500/50 bg-violet-500/10'
                  : 'border-border bg-muted/20'
              }`}
            >
              <div className="flex items-start gap-3">
                <div className={`mt-0.5 rounded-md p-1.5 ${
                  executionMode === 'ultra'
                    ? 'bg-violet-500/15 text-violet-600 dark:text-violet-300'
                    : 'bg-muted text-muted-foreground'
                }`}>
                  <Sparkles className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <label htmlFor="model-settings-ultra" className="text-sm font-medium">
                    {t('chat:ultra.title', { defaultValue: 'Ultra mode' })}
                  </label>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    {t('chat:ultra.description', {
                      defaultValue: 'Coordinates complex tasks with collaborating agents to implement, test and review. Keeps your chosen reasoning and permissions.',
                    })}
                  </p>
                  {executionModeLocked && (
                    <p className="mt-1 text-[11px] leading-relaxed text-amber-600 dark:text-amber-300">
                      {executionModePending
                        ? t('chat:ultra.saving', { defaultValue: 'Saving this mode before the next send…' })
                        : t('chat:ultra.lockedDuringRun', { defaultValue: 'Change Ultra after the current run or approval finishes.' })}
                    </p>
                  )}
                </div>
                <Switch
                  id="model-settings-ultra"
                  checked={executionMode === 'ultra'}
                  disabled={executionModeLocked}
                  onCheckedChange={(checked) => setExecutionMode(checked ? 'ultra' : 'standard')}
                  aria-label={t('chat:ultra.title', { defaultValue: 'Ultra mode' })}
                  aria-busy={executionModePending}
                />
              </div>
            </div>
          )}
          <div className="rounded-lg border bg-muted/20 p-3 space-y-3">
            <div className="flex items-start gap-3">
              <Repeat className="mt-0.5 h-4 w-4 text-muted-foreground shrink-0" />
              <div className="min-w-0 flex-1">
                <label htmlFor="model-settings-turn-limit" className="text-sm font-medium">
                  {t('chat:toolbar.turnLimitEnabled')}
                </label>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  {!turnLimitEnabled
                    ? t('chat:toolbar.turnLimitUnlimited')
                    : maxTurns === null
                      ? t('chat:toolbar.turnLimitAwaiting')
                      : t('chat:toolbar.turnLimitActive', { turns: maxTurns })}
                </p>
              </div>
              <Switch
                id="model-settings-turn-limit"
                checked={turnLimitEnabled}
                onCheckedChange={(checked) => {
                  setTurnLimitEnabled(checked);
                  if (!checked) setMaxTurns(null);
                }}
                aria-label={t('chat:toolbar.turnLimitEnabled')}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">
                  {t('chat:toolbar.maxTurns')}
                </label>
                <Input
                  type="number"
                  min={1}
                  max={100000}
                  value={maxTurns ?? ''}
                  disabled={!turnLimitEnabled}
                  onChange={(e) => {
                    const parsed = Number.parseInt(e.target.value, 10);
                    if (Number.isFinite(parsed)) {
                      setMaxTurns(Math.min(100000, Math.max(1, parsed)));
                    }
                  }}
                  className="h-7 text-xs font-mono px-1.5"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">
                  {t('chat:toolbar.maxAutoContinues')}
                </label>
                <Input
                  type="number"
                  min={0}
                  max={1000}
                  value={maxAutoContinues}
                  onChange={(e) => {
                    const parsed = Number.parseInt(e.target.value, 10);
                    if (Number.isFinite(parsed)) {
                      setMaxAutoContinues(Math.min(1000, Math.max(0, parsed)));
                    }
                  }}
                  className="h-7 text-xs font-mono px-1.5"
                />
              </div>
            </div>
          </div>
          <div className="flex gap-3">
            <div className="flex-1 space-y-1.5">
              <label className="text-xs text-muted-foreground">{t('chat:toolbar.temperature', { defaultValue: 'Temperature' })}</label>
              <div className="flex items-center gap-1.5">
                <Thermometer className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <Input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={fixedTemperature ?? temperature ?? ''}
                  disabled={fixedTemperature !== null}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === '') { setTemperature(null); return; }
                    const parsed = parseFloat(v);
                    if (!Number.isFinite(parsed)) return;
                    setTemperature(Math.min(1, Math.max(0, parsed)));
                  }}
                  placeholder={t('chat:toolbar.temperatureAuto', { defaultValue: 'auto' })}
                  className="h-7 text-xs font-mono px-1.5"
                />
              </div>
            </div>
          </div>
          {showAgent && setReasoningEffort && reasoningLevels && reasoningLevels.length > 0 && (
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">{t('chat:toolbar.effort', { defaultValue: 'Reasoning effort' })}</label>
              <div className="flex items-center gap-1.5">
                <Gauge className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <select
                  aria-label={t('chat:toolbar.effort', { defaultValue: 'Reasoning effort' })}
                  className="h-7 flex-1 rounded border bg-background px-1.5 text-xs"
                  value={reasoningEffort ?? ''}
                  disabled={false}
                  onChange={(e) => setReasoningEffort?.(e.target.value === '' ? null : e.target.value)}
                >
                  <option value="">{t('chat:toolbar.effortAuto', { defaultValue: 'auto' })}</option>
                  {reasoningLevels.map((lv) => (
                    <option key={lv} value={lv}>
                      {lv}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
          {showAgent && agent === 'plan' && setPlanDepth && (
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">{t('chat:toolbar.planDepth', { defaultValue: 'Plan depth' })}</label>
              <div className="flex items-center gap-1.5">
                <Layers className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <select
                  aria-label={t('chat:toolbar.planDepth', { defaultValue: 'Plan depth' })}
                  className="h-7 flex-1 rounded border bg-background px-1.5 text-xs"
                  value={planDepth ?? 'normal'}
                  onChange={(e) => setPlanDepth?.(e.target.value)}
                >
                  <option value="simple">{t('chat:toolbar.planDepthSimple', { defaultValue: 'Simple' })}</option>
                  <option value="normal">{t('chat:toolbar.planDepthNormal', { defaultValue: 'Normal' })}</option>
                  <option value="complex">{t('chat:toolbar.planDepthComplex', { defaultValue: 'Complex' })}</option>
                </select>
              </div>
            </div>
          )}
          {setResponseLanguage && (
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">{t('chat:toolbar.language', { defaultValue: 'Response language' })}</label>
              <div className="flex items-center gap-1.5">
                <Languages className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <select
                  aria-label={t('chat:toolbar.language', { defaultValue: 'Response language' })}
                  className="h-7 flex-1 rounded border bg-background px-1.5 text-xs"
                  value={responseLanguage ?? ''}
                  onChange={(e) => setResponseLanguage(e.target.value === '' ? null : e.target.value)}
                >
                  <option value="">{t('chat:toolbar.languageAuto', { defaultValue: "Auto (user's language)" })}</option>
                  <option value="Português (Brasil)">Português (Brasil)</option>
                  <option value="English">English</option>
                  <option value="Español">Español</option>
                  <option value="Français">Français</option>
                  <option value="Deutsch">Deutsch</option>
                  <option value="Italiano">Italiano</option>
                  <option value="中文">中文</option>
                  <option value="日本語">日本語</option>
                  {/* An externally-set value (project default / seed / future locale) may
                      not be in the list above — render it so the select reflects the real
                      override instead of silently falling back to "Auto". */}
                  {responseLanguage &&
                    !['Português (Brasil)', 'English', 'Español', 'Français', 'Deutsch', 'Italiano', '中文', '日本語'].includes(
                      responseLanguage,
                    ) && <option value={responseLanguage}>{responseLanguage}</option>}
                </select>
              </div>
            </div>
          )}
          {setOutputStyle && (
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">{t('chat:toolbar.outputStyle', { defaultValue: 'Output style' })}</label>
              <div className="flex items-center gap-1.5">
                <BookOpen className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <select
                  aria-label={t('chat:toolbar.outputStyle', { defaultValue: 'Output style' })}
                  className="h-7 flex-1 rounded border bg-background px-1.5 text-xs"
                  value={outputStyle ?? ''}
                  onChange={(e) => setOutputStyle(e.target.value === '' ? null : e.target.value)}
                >
                  <option value="">{t('chat:toolbar.outputStyleProactive', { defaultValue: 'Proactive (default)' })}</option>
                  <option value="explanatory">{t('chat:toolbar.outputStyleExplanatory', { defaultValue: 'Explanatory' })}</option>
                  <option value="learning">{t('chat:toolbar.outputStyleLearning', { defaultValue: 'Learning' })}</option>
                </select>
              </div>
            </div>
          )}
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">{t('chat:toolbar.fallback', { defaultValue: 'Fallback' })}</label>
            <FallbackPicker
              fallbackProvider={fallbackProvider}
              fallbackModel={fallbackModel}
              providerOptions={providerOptions}
              getModelsForProvider={getModelsForProvider}
              onChange={onFallbackChange}
            />
          </div>
      </div>
    </>
  );
}
