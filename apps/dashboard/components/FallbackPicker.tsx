/**
 * Reusable Fallback Provider+Model picker.
 *
 * Compact inline widget showing the current fallback (if any) with a
 * provider+model selector. Used in:
 * - Chat session toolbar (settings popover)
 * - Company new session dialog (master fallback)
 * - Template builder (per-role fallback)
 */
import { ChevronRight, Shield, X } from 'lucide-react';
import { Badge } from './ui/badge.js';
import type { ProviderOption, EnrichedProviderModel } from '../features/chat/types.js';

interface FallbackPickerProps {
  /** Current fallback provider id (null = no fallback). */
  fallbackProvider: string | null;
  /** Current fallback model. */
  fallbackModel: string | null;
  /** All available providers with their models. */
  providerOptions: ProviderOption[];
  /** Get models for a given provider id. */
  getModelsForProvider: (providerId: string) => EnrichedProviderModel[];
  /** Called when fallback changes. Null values clear the fallback. */
  onChange: (provider: string | null, model: string | null) => void;
  /** Optional label override. */
  label?: string;
  /** Compact mode (no label, smaller). */
  compact?: boolean;
}

export function FallbackPicker({
  fallbackProvider,
  fallbackModel,
  providerOptions,
  getModelsForProvider,
  onChange,
  label,
  compact,
}: FallbackPickerProps) {
  const currentModels = fallbackProvider ? getModelsForProvider(fallbackProvider) : [];

  return (
    <div className={compact ? 'space-y-1' : 'space-y-2'}>
      {!compact && (
        <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
          <Shield className="h-3 w-3" />
          {label ?? 'Fallback (auto-switch on error)'}
        </label>
      )}

      {fallbackProvider ? (
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="outline" className="text-xs py-0.5 px-2 gap-1">
            <Shield className="h-3 w-3 text-amber-500" />
            {providerOptions.find((p) => p.id === fallbackProvider)?.label ?? fallbackProvider}
            {fallbackModel && (
              <span className="font-mono opacity-70 ml-0.5">{fallbackModel}</span>
            )}
            <button
              type="button"
              className="ml-1 hover:text-destructive transition-colors"
              onClick={() => onChange(null, null)}
              title="Remover fallback"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        </div>
      ) : null}

      <div className={`grid gap-2 ${compact ? 'grid-cols-2' : 'grid-cols-[1fr_1fr]'}`}>
        <select
          value={fallbackProvider ?? ''}
          onChange={(e) => {
            const newProvider = e.target.value || null;
            if (!newProvider) {
              onChange(null, null);
              return;
            }
            // Auto-select first model
            const models = getModelsForProvider(newProvider);
            const defaultModel = models.length > 0 ? models[0].id : '';
            onChange(newProvider, defaultModel);
          }}
          className="rounded-md border bg-background px-2 py-1 text-xs"
        >
          <option value="">{compact ? '- fallback -' : 'Sem fallback'}</option>
          {providerOptions.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>

        {fallbackProvider && (
          currentModels.length > 0 ? (
            <select
              value={fallbackModel ?? ''}
              onChange={(e) => onChange(fallbackProvider, e.target.value || null)}
              className="rounded-md border bg-background px-2 py-1 text-xs font-mono"
            >
              {currentModels.map((m) => (
                <option key={`${m.id}:${m.mode ?? ''}`} value={m.mode ? `${m.id}::${m.mode}` : m.id}>
                  {m.id}{m.mode ? ` (${m.mode})` : ''}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={fallbackModel ?? ''}
              onChange={(e) => onChange(fallbackProvider, e.target.value || null)}
              placeholder="model name"
              className="rounded-md border bg-background px-2 py-1 text-xs font-mono"
            />
          )
        )}
      </div>
    </div>
  );
}
