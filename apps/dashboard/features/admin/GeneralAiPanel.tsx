import { useCallback, useEffect, useState } from 'react';
import { Loader2, Save, Sparkles } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';

interface GeneralAiModel {
  model_id: string;
  name: string;
}

interface GeneralAiProvider {
  id: string;
  name: string;
  kind: string;
  models: GeneralAiModel[];
}

interface GeneralAiConfig {
  providerId: string | null;
  modelId: string | null;
  availableProviders: GeneralAiProvider[];
}

export function GeneralAiPanel() {
  const [config, setConfig] = useState<GeneralAiConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [providerId, setProviderId] = useState<string>('');
  const [modelId, setModelId] = useState<string>('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/api/admin/general-ai');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as GeneralAiConfig;
      setConfig(data);
      setProviderId(data.providerId ?? '');
      setModelId(data.modelId ?? '');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const currentProvider = config?.availableProviders.find((p) => p.id === providerId) ?? null;

  useEffect(() => {
    if (!currentProvider) return;
    if (modelId && currentProvider.models.some((m) => m.model_id === modelId)) return;
    // Reset to first model whenever the provider changes or the previously
    // selected model is no longer listed.
    setModelId(currentProvider.models[0]?.model_id ?? '');
  }, [currentProvider, modelId]);

  async function save() {
    if (!providerId || !modelId) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch('/api/admin/general-ai', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerId, modelId }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      setSavedAt(Date.now());
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const providers = config?.availableProviders ?? [];
  const noProviders = !loading && providers.length === 0;
  const dirty = providerId !== (config?.providerId ?? '') || modelId !== (config?.modelId ?? '');
  const canSave = !!providerId && !!modelId && dirty && !saving;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4" />
            IA Geral
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Modelo usado em funcionalidades utilitárias de IA do projeto (ex: gerar
            mensagens de commit). Não afeta os modelos do agent nem do coder.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
            </div>
          )}

          {noProviders && (
            <div className="text-sm text-muted-foreground border rounded-md p-3 bg-muted/20">
              Nenhum provider marcado como <strong>IA geral</strong>. Abra a aba
              Providers, edite um provider e ative a chave <em>IA geral</em>.
            </div>
          )}

          {providers.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium">Provider</label>
                <Select value={providerId} onValueChange={setProviderId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Selecione um provider" />
                  </SelectTrigger>
                  <SelectContent>
                    {providers.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name} <span className="text-muted-foreground">({p.kind})</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <label className="text-xs font-medium">Modelo</label>
                <Select
                  value={modelId}
                  onValueChange={setModelId}
                  disabled={!currentProvider || currentProvider.models.length === 0}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Selecione um modelo" />
                  </SelectTrigger>
                  <SelectContent>
                    {(currentProvider?.models ?? []).map((m) => (
                      <SelectItem key={m.model_id} value={m.model_id}>
                        {m.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {currentProvider && currentProvider.models.length === 0 && (
                  <div className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                    Este provider não tem modelos habilitados.
                  </div>
                )}
              </div>
            </div>
          )}

          {error && <div className="text-sm text-destructive">{error}</div>}

          <div className="flex items-center gap-3 pt-1">
            <Button onClick={save} disabled={!canSave}>
              {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
              Salvar seleção
            </Button>
            {savedAt && !dirty && (
              <span className="text-xs text-muted-foreground">Salvo.</span>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
