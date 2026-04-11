import { useEffect, useState } from 'react';
import { Star } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { fetchProviders, saveProvider } from './api.js';
import type { AdminProvider } from './types.js';

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
  const [model, setModel] = useState<string>((provider.extra?.hyde_model as string) ?? '');
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

      <div className="flex-1 flex items-center gap-2">
        <Input
          className="h-8 text-sm font-mono"
          placeholder={defaultFor(provider.kind)}
          value={model}
          onChange={(e) => { setModel(e.target.value); setSavedOk(false); }}
        />
        <Button
          size="sm"
          variant={savedOk ? 'outline' : 'default'}
          className="h-8 shrink-0"
          onClick={() => void handleSave()}
          disabled={saving}
        >
          {saving ? 'Saving…' : savedOk ? 'Saved' : 'Save'}
        </Button>
      </div>

      {error && <span className="text-xs text-destructive shrink-0">{error}</span>}
    </div>
  );
}

export function HydePanel() {
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
        Configure which model each provider uses for HyDE (Hypothetical Document Embeddings) query
        expansion during hybrid search. Leave blank to use the provider default.{' '}
        <span className="inline-flex items-center gap-1">
          HyDE uses the default provider{' '}
          <Star className="h-3 w-3 fill-yellow-400 text-yellow-400 inline" />.
        </span>
      </p>

      {loading && <div className="text-sm text-muted-foreground">Loading providers…</div>}

      {!loading && eligible.length === 0 && (
        <div className="text-sm text-muted-foreground border rounded-lg p-6 text-center">
          No eligible providers configured. Add an Anthropic, OpenAI, DeepSeek, ZAI, or Gemini
          provider in the Providers &amp; Models tab.
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
