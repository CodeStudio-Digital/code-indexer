import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

export interface AgentRuntimeModelOption {
  id: string;
  name: string;
  mode?: string | null;
  supported_reasoning_levels?: string[] | null;
  default_reasoning_level?: string | null;
}

export interface AgentRuntimeValue {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export function AgentRuntimeFields({
  value,
  providerOptions,
  getModelsForProvider,
  onChange,
  disabled = false,
  compact = false,
}: {
  value: AgentRuntimeValue;
  providerOptions: Array<{ id: string; label: string }>;
  getModelsForProvider: (provider: string) => AgentRuntimeModelOption[];
  onChange: (patch: Partial<AgentRuntimeValue>) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const { t } = useTranslation('agents');
  const models = useMemo(() => getModelsForProvider(value.provider), [getModelsForProvider, value.provider]);
  const modelValue = (model: AgentRuntimeModelOption) => model.mode ? `${model.id}::${model.mode}` : model.id;
  const selectedModel = models.find((candidate) => modelValue(candidate) === value.model)
    ?? models.find((candidate) => candidate.id === value.model);
  const reasoningLevels = selectedModel?.supported_reasoning_levels ?? [];
  const fieldClass = compact ? 'space-y-1' : 'space-y-1.5';
  const controlClass = compact
    ? 'h-8 w-full rounded border bg-background px-2 text-[11px]'
    : 'w-full rounded-md border bg-background px-3 py-1.5 text-sm';

  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-2 gap-2">
        <label className={fieldClass}>
          <span className="block text-[10px] font-medium text-muted-foreground">{t('role.provider', { defaultValue: 'Provider' })}</span>
          <select
            value={value.provider}
            disabled={disabled}
            onChange={(event) => {
              const provider = event.target.value;
              const first = getModelsForProvider(provider)[0];
              const firstModel = first ? modelValue(first) : '';
              onChange({ provider, model: firstModel, reasoningEffort: undefined });
            }}
            className={controlClass}
          >
            {providerOptions.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
          </select>
        </label>
        <label className={fieldClass}>
          <span className="block text-[10px] font-medium text-muted-foreground">{t('role.model', { defaultValue: 'Modelo' })}</span>
          {models.length > 0 ? (
            <select value={value.model} disabled={disabled} onChange={(event) => onChange({ model: event.target.value, reasoningEffort: undefined })} className={controlClass}>
              {models.map((model) => <option key={`${model.id}:${model.mode ?? ''}`} value={modelValue(model)}>{model.name}{model.mode ? ` (${model.mode})` : ''}</option>)}
            </select>
          ) : (
            <input value={value.model} disabled={disabled} onChange={(event) => onChange({ model: event.target.value, reasoningEffort: undefined })} className={`${controlClass} font-mono`} placeholder="model-name" />
          )}
        </label>
      </div>
      {reasoningLevels.length > 0 ? (
        <label className={fieldClass}>
          <span className="flex items-center justify-between text-[10px] font-medium text-muted-foreground">
            <span>{t('role.effort', { defaultValue: 'Reasoning effort' })}</span>
            <span className="font-mono font-normal">{reasoningLevels.join(' · ')}</span>
          </span>
          <select value={value.reasoningEffort ?? ''} disabled={disabled} onChange={(event) => onChange({ reasoningEffort: event.target.value || undefined })} className={controlClass}>
            <option value="">{t('role.effortAuto', { defaultValue: `Automático${selectedModel?.default_reasoning_level ? ` (${selectedModel.default_reasoning_level})` : ''}` })}</option>
            {reasoningLevels.map((level) => <option key={level} value={level}>{level}</option>)}
          </select>
        </label>
      ) : (
        <p className="text-[9px] text-muted-foreground">Este modelo não declara níveis discretos de reasoning effort.</p>
      )}
    </div>
  );
}
