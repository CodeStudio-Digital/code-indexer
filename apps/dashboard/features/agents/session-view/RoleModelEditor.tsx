import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';

interface RoleModelEditorProps {
  role: Record<string, string>;
  providerOptions: Array<{ id: string; label: string }>;
  getModelsForProvider: (provider: string) => Array<{ id: string; name: string; mode?: string }>;
  getDefaultModel: (provider: string) => string;
  onApply: (provider: string, model: string) => void;
}

/**
 * Inline (provider, model) editor used in the agents sidebar's role
 * list. Picking a provider auto-selects its default model so the user
 * can't accidentally save an incompatible pair. The "Apply" button is
 * disabled until something actually changes.
 */
export function RoleModelEditor({
  role,
  providerOptions,
  getModelsForProvider,
  getDefaultModel,
  onApply,
}: RoleModelEditorProps) {
  const { t } = useTranslation('agents');
  const [provider, setProvider] = useState(role.provider);
  const [model, setModel] = useState(role.model);
  const models = getModelsForProvider(provider);

  function handleProviderChange(newProvider: string) {
    setProvider(newProvider);
    setModel(getDefaultModel(newProvider));
  }

  return (
    <div className="space-y-1.5 pt-1">
      <select
        value={provider}
        onChange={(e) => handleProviderChange(e.target.value)}
        className="w-full rounded border bg-background px-2 py-1 text-[10px]"
      >
        {providerOptions.map((p) => (
          <option key={p.id} value={p.id}>{p.label}</option>
        ))}
      </select>
      {models.length > 0 ? (
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="w-full rounded border bg-background px-2 py-1 text-[10px] font-mono"
        >
          {models.map((m) => (
            <option key={m.mode ? `${m.id}::${m.mode}` : m.id} value={m.id}>
              {m.name}{m.mode ? ` (${m.mode})` : ''}
            </option>
          ))}
        </select>
      ) : (
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="w-full rounded border bg-background px-2 py-1 text-[10px] font-mono"
          placeholder="model-name"
        />
      )}
      <Button
        size="sm"
        variant="default"
        className="w-full h-6 text-[10px] gap-1"
        disabled={provider === role.provider && model === role.model}
        onClick={() => onApply(provider, model)}
      >
        <Check className="h-2.5 w-2.5" /> {t('kanban.card.apply')}
      </Button>
    </div>
  );
}
