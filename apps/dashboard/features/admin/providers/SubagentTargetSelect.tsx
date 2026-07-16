import { useEffect } from 'react';
import type { AdminModel, AdminProvider } from '../types.js';

/**
 * Reusable provider + model selector pair for subagent targets. Used both for
 * the single "default" subagent control and for each per-profile override row.
 * Encapsulates the enabled-coder-provider list, the target provider's model
 * list (parent → base models, else lazily loaded), the missing-model fallback,
 * and the "changing provider resets the model" rule.
 */
interface SubagentTargetSelectProps {
  /** The card's provider — the target defaults to this when no provider is picked. */
  parentProviderId: string;
  /** Selected subagent provider id (null = the empty default/"same" option). */
  providerId: string | null;
  /** Selected model id (null = the provider's default model). */
  modelId: string | null;
  /** Enabled coder providers to offer (should exclude the parent itself). */
  providerOptions: AdminProvider[];
  allProviders: AdminProvider[];
  /** Parent provider's own models — used when the target is the parent. */
  baseModels: AdminModel[];
  providerModelsById: Record<string, AdminModel[]>;
  onLoadProviderModels: (providerId: string) => void | Promise<void>;
  onChange: (providerId: string | null, modelId: string | null) => void;
  /** Current reasoning-effort override (null = inherit). */
  effort: string | null;
  /** Persist an effort change (null clears the override). */
  onEffortChange: (effort: string | null) => void;
  providerLabel: string;
  modelLabel: string;
  effortLabel: string;
  providerEmptyLabel: string;
  modelEmptyLabel: string;
  effortEmptyLabel: string;
  providerAriaLabel: string;
  modelAriaLabel: string;
  effortAriaLabel: string;
}

export function SubagentTargetSelect({
  parentProviderId,
  providerId,
  modelId,
  providerOptions,
  allProviders,
  baseModels,
  providerModelsById,
  onLoadProviderModels,
  onChange,
  effort,
  onEffortChange,
  providerLabel,
  modelLabel,
  effortLabel,
  providerEmptyLabel,
  modelEmptyLabel,
  effortEmptyLabel,
  providerAriaLabel,
  modelAriaLabel,
  effortAriaLabel,
}: SubagentTargetSelectProps) {
  const targetProviderId = providerId ?? parentProviderId;
  const models = providerModelsById[targetProviderId]
    ?? (targetProviderId === parentProviderId ? baseModels : []);
  const enabledModels = models.filter((m) => m.enabled);
  const modelMissing = !!modelId && !enabledModels.some((m) => m.model_id === modelId);

  // Effort is model-specific: only expose it when the chosen model advertises
  // reasoning levels ("se o modelo permitir").
  const selectedModel = modelId ? enabledModels.find((m) => m.model_id === modelId) : undefined;
  const effortLevels = (selectedModel?.supported_reasoning_levels ?? []).map((lv) =>
    typeof lv === 'string' ? lv : String((lv as Record<string, unknown>)?.effort ?? lv),
  );
  const effortMissing = !!effort && !effortLevels.includes(effort);
  // Reset a stale effort override when the provider/model changes under it.
  const clearEffortIfSet = () => { if (effort) onEffortChange(null); };

  // Keep the selected provider visible even if it was later disabled.
  const selected = providerId ? allProviders.find((c) => c.id === providerId) : null;
  const options = selected && !providerOptions.some((c) => c.id === selected.id)
    ? [selected, ...providerOptions]
    : providerOptions;

  useEffect(() => {
    if (targetProviderId === parentProviderId) return;
    if (providerModelsById[targetProviderId]) return;
    void onLoadProviderModels(targetProviderId);
  }, [targetProviderId, parentProviderId, providerModelsById, onLoadProviderModels]);

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <label className="grid gap-1 text-sm font-medium">
        <span>{providerLabel}</span>
        <select
          aria-label={providerAriaLabel}
          className="h-8 rounded border bg-background px-2 text-xs"
          value={providerId ?? ''}
          onChange={(e) => {
            const next = e.target.value === '' ? null : e.target.value;
            onChange(next, null); // provider change resets the model
            clearEffortIfSet();
            if (next && !providerModelsById[next]) void onLoadProviderModels(next);
          }}
        >
          <option value="">{providerEmptyLabel}</option>
          {options.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-sm font-medium">
        <span>{modelLabel}</span>
        <select
          aria-label={modelAriaLabel}
          className="h-8 rounded border bg-background px-2 text-xs"
          value={modelId ?? ''}
          onChange={(e) => {
            onChange(providerId, e.target.value === '' ? null : e.target.value);
            clearEffortIfSet(); // effort is model-specific
          }}
        >
          <option value="">{modelEmptyLabel}</option>
          {modelMissing && <option value={modelId}>{modelId}</option>}
          {enabledModels.map((m) => (
            <option key={`${m.provider_id}:${m.model_id}:${m.mode}`} value={m.model_id}>
              {m.name || m.model_id}
            </option>
          ))}
        </select>
      </label>
      {effortLevels.length > 0 && (
        <label className="grid gap-1 text-sm font-medium">
          <span>{effortLabel}</span>
          <select
            aria-label={effortAriaLabel}
            className="h-8 rounded border bg-background px-2 text-xs"
            value={effort ?? ''}
            onChange={(e) => onEffortChange(e.target.value === '' ? null : e.target.value)}
          >
            <option value="">{effortEmptyLabel}</option>
            {effortMissing && <option value={effort}>{effort}</option>}
            {effortLevels.map((lv) => (
              <option key={lv} value={lv}>{lv}</option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
