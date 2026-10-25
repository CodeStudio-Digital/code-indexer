import type { AgentPreset } from '@mcp/api-bus';
import { Gauge, Repeat, Sparkles, Thermometer } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { Switch } from '../../components/ui/switch.js';
import { AgentPicker } from './composer/AgentPicker.js';
import { providerSupportsThinking, resolveReasoningLevels } from './composer/provider-caps.js';
import { modelCanReason, ultraManagesThinking } from './execution-mode-state.js';
import type { EnrichedProviderModel, ExecutionMode, ProviderOption } from './types.js';

export interface SessionLaunchConfig {
  title: string;
  agent: AgentPreset;
  provider: string;
  model: string;
  executionMode: ExecutionMode;
  reasoningEffort: string | null;
  thinking: boolean;
  maxTurns: number | null;
  maxAutoContinues: number;
  temperature: number | null;
}

interface SessionLaunchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: SessionLaunchConfig;
  onChange: (value: SessionLaunchConfig) => void;
  onCreate: (value: SessionLaunchConfig) => void | Promise<void>;
  providerOptions: ProviderOption[];
  getModelsForProvider: (providerId: string) => EnrichedProviderModel[];
  creating?: boolean;
  lockedAgent?: AgentPreset;
  title?: string;
  description?: string;
}

function modelValue(model: EnrichedProviderModel): string {
  return model.mode ? `${model.id}::${model.mode}` : model.id;
}

export function firstModelValue(models: EnrichedProviderModel[]): string {
  return models[0] ? modelValue(models[0]) : '';
}

export function SessionLaunchDialog({
  open,
  onOpenChange,
  value,
  onChange,
  onCreate,
  providerOptions,
  getModelsForProvider,
  creating = false,
  lockedAgent,
  title,
  description,
}: SessionLaunchDialogProps) {
  const { t } = useTranslation(['chat', 'common']);
  const models = useMemo(
    () => getModelsForProvider(value.provider),
    [getModelsForProvider, value.provider],
  );
  const reasoningLevels = resolveReasoningLevels(value.provider, providerOptions, value.model);
  const supportsThinking = providerSupportsThinking(value.provider, providerOptions, value.model);
  const canReason = modelCanReason(value.provider, providerOptions, value.model);
  const ultraControlsThinking = ultraManagesThinking(
    value.executionMode,
    canReason,
  );
  const [turnLimitEnabled, setTurnLimitEnabled] = useState(
    value.maxTurns !== null,
  );
  useEffect(() => {
    setTurnLimitEnabled(value.maxTurns !== null);
  }, [value.maxTurns]);
  const patch = (next: Partial<SessionLaunchConfig>) => onChange({ ...value, ...next });

  const changeProvider = (provider: string) => {
    const model = firstModelValue(getModelsForProvider(provider));
    patch({ provider, model, reasoningEffort: null, thinking: false });
  };

  const changeModel = (model: string) => {
    const thinking = providerSupportsThinking(value.provider, providerOptions, model)
      ? value.thinking
      : false;
    patch({ model, reasoningEffort: null, thinking });
  };

  const submit = () => {
    if (!value.provider || !value.model || creating) return;
    void onCreate({
      ...value,
      title: value.title.trim(),
      reasoningEffort: value.reasoningEffort && reasoningLevels.includes(value.reasoningEffort)
        ? value.reasoningEffort
        : null,
      thinking: supportsThinking && value.thinking,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !creating && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title ?? t('chat:sessionLaunch.title')}</DialogTitle>
          <DialogDescription>{description ?? t('chat:sessionLaunch.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <label htmlFor="session-launch-title" className="text-xs font-medium text-muted-foreground">
              {t('chat:sessionLaunch.sessionTitle')}
            </label>
            <Input
              id="session-launch-title"
              autoFocus
              value={value.title}
              onChange={(event) => patch({ title: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submit();
              }}
              placeholder={t('chat:sessionTitlePlaceholder')}
            />
          </div>

          <div className="space-y-1.5">
            <span className="block text-xs font-medium text-muted-foreground">
              {t('chat:sessionLaunch.agent')}
            </span>
            {lockedAgent ? (
              <div className="h-9 rounded-md border bg-muted/30 px-3 flex items-center text-sm">
                {t(`chat:agentPicker.labels.${lockedAgent}`, { defaultValue: lockedAgent })}
              </div>
            ) : (
              <AgentPicker value={value.agent} onChange={(agent) => patch({ agent })} />
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label htmlFor="session-launch-provider" className="text-xs font-medium text-muted-foreground">
                {t('chat:toolbar.provider')}
              </label>
              <select
                id="session-launch-provider"
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                value={value.provider}
                onChange={(event) => changeProvider(event.target.value)}
              >
                {providerOptions.map((provider) => (
                  <option key={provider.id} value={provider.id}>{provider.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="session-launch-model" className="text-xs font-medium text-muted-foreground">
                {t('chat:toolbar.model')}
              </label>
              {models.length > 0 ? (
                <select
                  id="session-launch-model"
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  value={value.model}
                  onChange={(event) => changeModel(event.target.value)}
                >
                  {models.map((model) => (
                    <option key={modelValue(model)} value={modelValue(model)}>
                      {model.name || model.id}{model.mode ? ` (${model.mode})` : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  id="session-launch-model"
                  value={value.model}
                  onChange={(event) => changeModel(event.target.value)}
                  placeholder={t('chat:sessionLaunch.modelPlaceholder')}
                  className="font-mono"
                />
              )}
            </div>
          </div>

          <div
            className={`rounded-lg border p-3 transition-colors ${
              value.executionMode === 'ultra'
                ? 'border-violet-500/50 bg-violet-500/10'
                : 'border-border bg-muted/20'
            }`}
          >
            <div className="flex items-start gap-3">
              <div className={`mt-0.5 rounded-md p-1.5 ${
                value.executionMode === 'ultra'
                  ? 'bg-violet-500/15 text-violet-600 dark:text-violet-300'
                  : 'bg-muted text-muted-foreground'
              }`}>
                <Sparkles className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <label htmlFor="session-launch-ultra" className="text-sm font-medium">
                  {t('chat:ultra.title')}
                </label>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  {t('chat:ultra.description')}
                </p>
              </div>
              <Switch
                id="session-launch-ultra"
                checked={value.executionMode === 'ultra'}
                onCheckedChange={(checked) => patch({ executionMode: checked ? 'ultra' : 'standard' })}
                aria-label={t('chat:ultra.title')}
              />
            </div>
          </div>

          <div className="rounded-lg border bg-muted/20 p-3 space-y-3">
            <div className="flex items-start gap-3">
              <Repeat className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <label htmlFor="session-launch-turn-limit" className="text-sm font-medium">
                  {t('chat:toolbar.turnLimitEnabled')}
                </label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {!turnLimitEnabled
                    ? t('chat:toolbar.turnLimitUnlimited')
                    : value.maxTurns === null
                      ? t('chat:toolbar.turnLimitAwaiting')
                      : t('chat:toolbar.turnLimitActive', { turns: value.maxTurns })}
                </p>
              </div>
              <Switch
                id="session-launch-turn-limit"
                checked={turnLimitEnabled}
                onCheckedChange={(checked) => {
                  setTurnLimitEnabled(checked);
                  if (!checked) patch({ maxTurns: null });
                }}
                aria-label={t('chat:toolbar.turnLimitEnabled')}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label htmlFor="session-launch-turns" className="text-xs font-medium text-muted-foreground">
                  {t('chat:toolbar.maxTurns')}
                </label>
                <Input
                  id="session-launch-turns"
                  type="number"
                  min={1}
                  max={100000}
                  disabled={!turnLimitEnabled}
                  value={value.maxTurns ?? ''}
                  onChange={(event) => {
                    const parsed = Number.parseInt(event.target.value, 10);
                    if (Number.isFinite(parsed)) {
                      patch({ maxTurns: Math.min(100000, Math.max(1, parsed)) });
                    }
                  }}
                  className="font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="session-launch-auto-continues" className="text-xs font-medium text-muted-foreground">
                  {t('chat:toolbar.maxAutoContinues')}
                </label>
                <Input
                  id="session-launch-auto-continues"
                  type="number"
                  min={0}
                  max={1000}
                  value={value.maxAutoContinues}
                  onChange={(event) => {
                    const parsed = Number.parseInt(event.target.value, 10);
                    if (Number.isFinite(parsed)) {
                      patch({ maxAutoContinues: Math.min(1000, Math.max(0, parsed)) });
                    }
                  }}
                  className="font-mono"
                />
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label htmlFor="session-launch-temperature" className="text-xs font-medium text-muted-foreground">
                {t('chat:toolbar.temperature', { defaultValue: 'Temperature' })}
              </label>
              <div className="flex items-center gap-2">
                <Thermometer className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <Input
                  id="session-launch-temperature"
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={value.temperature ?? ''}
                  onChange={(event) => {
                    const next = event.target.value;
                    if (next === '') {
                      patch({ temperature: null });
                      return;
                    }
                    const parsed = Number.parseFloat(next);
                    if (Number.isFinite(parsed)) patch({ temperature: Math.min(1, Math.max(0, parsed)) });
                  }}
                  placeholder={t('chat:sessionLaunch.automatic')}
                  className="font-mono"
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label htmlFor="session-launch-effort" className="text-xs font-medium text-muted-foreground">
                {t('chat:toolbar.effort')}
              </label>
              <div className="flex items-center gap-2">
                <Gauge className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <select
                  id="session-launch-effort"
                  className="h-9 flex-1 rounded-md border bg-background px-2 text-sm disabled:opacity-50"
                  value={value.reasoningEffort ?? ''}
                  disabled={reasoningLevels.length === 0}
                  onChange={(event) => patch({ reasoningEffort: event.target.value || null })}
                >
                  <option value="">{t('chat:sessionLaunch.automatic')}</option>
                  {reasoningLevels.map((level) => <option key={level} value={level}>{level}</option>)}
                </select>
              </div>
            </div>
            <div className="space-y-1.5">
              <span className="block text-xs font-medium text-muted-foreground">
                {t('chat:sessionLaunch.thinking')}
              </span>
              <div className="h-9 rounded-md border px-3 flex items-center justify-between gap-3">
                <span className="text-sm text-muted-foreground">
                  {ultraControlsThinking
                    ? t('chat:ultra.thinkingManagedShort', { defaultValue: 'Managed by Ultra; Standard preference preserved' })
                    : supportsThinking
                      ? t('chat:sessionLaunch.thinkingHint')
                      : canReason
                        ? t('chat:sessionLaunch.thinkingAutomatic', { defaultValue: 'Automatic for this model' })
                        : t('chat:sessionLaunch.unavailable')}
                </span>
                <Switch
                  checked={ultraControlsThinking || (supportsThinking && value.thinking)}
                  disabled={!supportsThinking || ultraControlsThinking}
                  onCheckedChange={(thinking) => patch({ thinking })}
                  aria-label={t('chat:sessionLaunch.thinking')}
                />
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={creating} onClick={() => onOpenChange(false)}>
            {t('common:actions.cancel')}
          </Button>
          <Button disabled={creating || !value.provider || !value.model} onClick={submit}>
            {creating ? t('chat:sessionLaunch.creating') : t('common:actions.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
