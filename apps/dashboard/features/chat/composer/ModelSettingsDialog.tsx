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
import { useTranslation } from 'react-i18next';
import { BookOpen, Gauge, Languages, Layers, Repeat, Thermometer } from 'lucide-react';
import { Input } from '../../../components/ui/input.js';
import { Combobox, type ComboboxOption } from '../../../components/ui/combobox.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../../components/ui/dialog.js';
import { FallbackPicker } from '../../../components/FallbackPicker.js';
import { PROVIDERS } from '../constants.js';
import type { EnrichedProviderModel, ProviderOption } from '../types.js';
import { AgentPicker } from './AgentPicker.js';

type AgentId = 'explore' | 'plan' | 'build' | 'admin' | 'spec' | 'api';

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
  temperature: number | null;
  setTemperature: (v: number | null) => void;
  reasoningEffort?: string | null;
  setReasoningEffort?: (v: string | null) => void;
  reasoningLevels?: string[];
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
  temperature,
  setTemperature,
  reasoningEffort,
  setReasoningEffort,
  reasoningLevels,
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
}: ModelSettingsDialogProps) {
  const { t } = useTranslation(['chat', 'common']);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
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
              options={providerOptions.map((p) => ({ value: p.id, label: p.label }))}
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
                options={currentProviderModels.map<ComboboxOption>((m) => ({
                  value: m.mode ? `${m.id}::${m.mode}` : m.id,
                  label: m.id,
                  hint: m.mode,
                }))}
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
          <div className="flex gap-3">
            <div className="flex-1 space-y-1.5">
              <label className="text-xs text-muted-foreground">{t('chat:toolbar.maxTurns')}</label>
              <div className="flex items-center gap-1.5">
                <Repeat className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <Input
                  type="number"
                  min={1}
                  max={200}
                  value={maxTurns ?? ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    setMaxTurns(v === '' ? null : Math.max(1, parseInt(v, 10) || 1));
                  }}
                  placeholder="50"
                  className="h-7 text-xs font-mono px-1.5"
                />
              </div>
            </div>
            <div className="flex-1 space-y-1.5">
              <label className="text-xs text-muted-foreground">{t('chat:toolbar.temperature', { defaultValue: 'Temperature' })}</label>
              <div className="flex items-center gap-1.5">
                <Thermometer className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <Input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={temperature ?? ''}
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
      </DialogContent>
    </Dialog>
  );
}
