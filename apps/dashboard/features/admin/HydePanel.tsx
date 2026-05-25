import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Star } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Combobox, type ComboboxOption } from '../../components/ui/combobox.js';
import { fetchProviders, fetchProviderModels, saveProvider } from './api.js';
import type { AdminModel, AdminProvider } from './types.js';

const DEFAULT_HYDE_MODEL: Record<string, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4o-mini',
  deepseek: 'deepseek-chat',
  zai: 'glm-4.5-flash',
  gemini: 'gemini-2.0-flash-lite',
};

function defaultFor(kind: string): string {
  return DEFAULT_HYDE_MODEL[kind] ?? 'gpt-4o-mini';
}

function ProviderRow({ provider, onSaved }: { provider: AdminProvider; onSaved: () => void }) {
  const { t } = useTranslation(['admin', 'common']);
  const [model, setModel] = useState<string>((provider.extra?.hyde_model as string) ?? '');
  const [models, setModels] = useState<AdminModel[] | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the model catalogue for this provider once on mount. The Combobox
  // below uses it to populate options; the user can still type a free-form
  // model id that's not in the list (handy for newly-released models the
  // discovery endpoint hasn't picked up yet).
  useEffect(() => {
    let cancelled = false;
    setLoadingModels(true);
    fetchProviderModels(provider.id)
      .then((list) => {
        if (!cancelled) setModels(list);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingModels(false);
      });
    return () => {
      cancelled = true;
    };
  }, [provider.id]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSavedOk(false);
    try {
      await saveProvider(
        { ...provider, extra: { ...provider.extra, hyde_model: model.trim() || undefined } },
        true,
      );
      setSavedOk(true);
      setTimeout(() => setSavedOk(false), 2000);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // De-duplicate (model_id, mode) pairs from the catalogue. The store can
  // emit the same model_id twice when a provider has multiple modes
  // (e.g. Z.AI's `glm-5` ships as both general and coding) — we surface
  // both so the user can pin to the right mode-routed cluster.
  const options: ComboboxOption[] = (models ?? []).map((m) => ({
    value: m.mode ? `${m.model_id}::${m.mode}` : m.model_id,
    label: m.model_id,
    hint: m.mode || undefined,
  }));
  // Sentinel option for the empty value, so the operator can explicitly
  // pick "use provider default" without having to clear the input.
  options.unshift({
    value: '',
    label: `(${t('common:status.default')}: ${defaultFor(provider.kind)})`,
  });

  return (
    <div className="flex items-center gap-3 py-3 px-4 rounded-lg border bg-card">
      <div className="flex items-center gap-2 w-44 shrink-0">
        <span className="font-medium text-sm truncate">{provider.name}</span>
        {provider.is_default && (
          <Star className="h-3.5 w-3.5 fill-yellow-400 text-yellow-400 shrink-0" />
        )}
        <Badge variant="outline" className="text-[10px] h-4 shrink-0 capitalize">
          {provider.kind}
        </Badge>
      </div>

      <div className="flex-1 flex items-center gap-2 min-w-0">
        <div className="flex-1 min-w-0 relative">
          <Combobox
            value={model}
            onChange={(v) => {
              setModel(v);
              setSavedOk(false);
            }}
            options={options}
            placeholder={defaultFor(provider.kind)}
            searchPlaceholder={t('common:actions.search')}
            emptyLabel={
              loadingModels
                ? t('common:actions.loading')
                : t('admin:tabs.search')
            }
          />
          {loadingModels && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
          )}
        </div>
        <Button
          size="sm"
          variant={savedOk ? 'outline' : 'default'}
          className="h-8 shrink-0"
          onClick={() => void handleSave()}
          disabled={saving}
        >
          {saving ? t('common:actions.saving') : savedOk ? t('common:actions.saved') : t('common:actions.save')}
        </Button>
      </div>

      {error && <span className="text-xs text-destructive shrink-0">{error}</span>}
    </div>
  );
}

export function HydePanel() {
  const { t } = useTranslation('admin');
  const [providers, setProviders] = useState<AdminProvider[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const ps = await fetchProviders();
      setProviders(ps);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  // HyDE skips OAuth-only providers (copilot, chatgpt, bedrock)
  const eligible = providers.filter((p) => !['copilot', 'chatgpt', 'bedrock'].includes(p.kind));

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t('hyde.description')}{' '}
        <span className="inline-flex items-center gap-1">
          {t('hyde.defaultProvider')}{' '}
          <Star className="h-3 w-3 fill-yellow-400 text-yellow-400 inline" />.
        </span>
      </p>

      {loading && <div className="text-sm text-muted-foreground">{t('hyde.loadingProviders')}</div>}

      {!loading && eligible.length === 0 && (
        <div className="text-sm text-muted-foreground border rounded-lg p-6 text-center">
          {t('hyde.noProviders')}
        </div>
      )}

      <div className="space-y-2">
        {eligible.map((p) => (
          <ProviderRow key={p.id} provider={p} onSaved={load} />
        ))}
      </div>
    </div>
  );
}
