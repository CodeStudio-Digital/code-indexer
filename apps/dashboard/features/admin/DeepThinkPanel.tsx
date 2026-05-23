import { useCallback, useEffect, useState } from 'react';
import { Loader2, Save, Sparkles } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { Input } from '../../components/ui/input.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';

interface DeepThinkModel {
  model_id: string;
  name: string;
}

interface DeepThinkProvider {
  id: string;
  name: string;
  kind: string;
  models: DeepThinkModel[];
}

interface DeepThinkEffective {
  provider: string | null;
  model: string | null;
  timeoutMs: number | null;
  historyWindow: number | null;
  minInputTokens: number | null;
  preThinkOnToolResults: boolean;
}

interface DeepThinkResponse {
  effective: DeepThinkEffective;
  stored: DeepThinkEffective | null;
  fallback: DeepThinkEffective;
  availableProviders: DeepThinkProvider[];
}

export function DeepThinkPanel() {
  const [data, setData] = useState<DeepThinkResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Form state — populated from `effective` on load, then edited locally.
  const [providerId, setProviderId] = useState<string>('');
  const [modelId, setModelId] = useState<string>('');
  const [timeoutMs, setTimeoutMs] = useState<string>('');
  const [historyWindow, setHistoryWindow] = useState<string>('');
  const [minInputTokens, setMinInputTokens] = useState<string>('');
  const [preThinkOnToolResults, setPreThinkOnToolResults] = useState<boolean>(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/api/admin/deepthink');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const resp = (await r.json()) as DeepThinkResponse;
      setData(resp);
      const eff = resp.effective;
      setProviderId(eff.provider ?? '');
      setModelId(eff.model ?? '');
      setTimeoutMs(eff.timeoutMs != null ? String(eff.timeoutMs) : '');
      setHistoryWindow(eff.historyWindow != null ? String(eff.historyWindow) : '');
      setMinInputTokens(eff.minInputTokens != null ? String(eff.minInputTokens) : '');
      setPreThinkOnToolResults(!!eff.preThinkOnToolResults);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const currentProvider = data?.availableProviders.find((p) => p.id === providerId) ?? null;

  // When the provider changes, snap modelId to the first model of that
  // provider if the current selection is no longer valid.
  useEffect(() => {
    if (!currentProvider) return;
    if (modelId && currentProvider.models.some((m) => m.model_id === modelId)) return;
    setModelId(currentProvider.models[0]?.model_id ?? '');
  }, [currentProvider, modelId]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const body = {
        provider: providerId || null,
        model: modelId || null,
        timeoutMs: timeoutMs.trim() === '' ? null : Number(timeoutMs),
        historyWindow: historyWindow.trim() === '' ? null : Number(historyWindow),
        minInputTokens: minInputTokens.trim() === '' ? null : Number(minInputTokens),
        preThinkOnToolResults,
      };
      const r = await fetch('/api/admin/deepthink', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
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

  const providers = data?.availableProviders ?? [];
  const noProviders = !loading && providers.length === 0;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-emerald-500" />
            deepThink (simulado)
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Quando o chip <code className="font-mono">deepthink+</code> for ativado em uma sessão
            individual, o runner chama um modelo auxiliar barato antes de cada turn do modelo
            principal e injeta o pensamento como bloco{' '}
            <code className="font-mono">&lt;thinking&gt;</code> de prefill. Estas configurações
            valem como default global — a sessão pode sobrescrever via body do request.
            Subordinates da Company seguem o <em>RoleConfig.deepThink*</em> (não este painel).
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
              Nenhum provider habilitado. Abra a aba <strong>Providers</strong> e habilite
              ao menos um para escolher um modelo auxiliar.
            </div>
          )}

          {providers.length > 0 && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium">Provider auxiliar</label>
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
                  <label className="text-xs font-medium">Modelo auxiliar</label>
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

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="text-xs font-medium">Timeout (ms)</label>
                  <Input
                    type="number"
                    min={500}
                    max={60000}
                    step={500}
                    value={timeoutMs}
                    onChange={(e) => setTimeoutMs(e.target.value)}
                    placeholder="8000"
                  />
                  <div className="text-[11px] text-muted-foreground mt-1">
                    Tempo máximo da chamada auxiliar antes de degradar.
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium">Janela de histórico</label>
                  <Input
                    type="number"
                    min={0}
                    max={50}
                    step={1}
                    value={historyWindow}
                    onChange={(e) => setHistoryWindow(e.target.value)}
                    placeholder="3"
                  />
                  <div className="text-[11px] text-muted-foreground mt-1">
                    Quantos pre-thoughts antigos manter no histórico.
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium">Min input tokens</label>
                  <Input
                    type="number"
                    min={0}
                    max={10000}
                    step={10}
                    value={minInputTokens}
                    onChange={(e) => setMinInputTokens(e.target.value)}
                    placeholder="0"
                  />
                  <div className="text-[11px] text-muted-foreground mt-1">
                    Pula o auxiliar quando o input do usuário é menor que isto (~chars/4).
                  </div>
                </div>
              </div>

              <div className="flex items-start gap-2 pt-1">
                <input
                  id="dt-pre-tool"
                  type="checkbox"
                  checked={preThinkOnToolResults}
                  onChange={(e) => setPreThinkOnToolResults(e.target.checked)}
                  className="mt-0.5"
                />
                <label htmlFor="dt-pre-tool" className="text-sm">
                  <span className="font-medium">Rodar pre-think em turns de tool_result</span>
                  <div className="text-[11px] text-muted-foreground">
                    Por padrão, turns que respondem a um tool_result pulam o auxiliar
                    (geralmente são só roteamento da próxima tool). Marque para incluí-los.
                  </div>
                </label>
              </div>
            </>
          )}

          {error && <div className="text-sm text-destructive">{error}</div>}

          {data?.fallback && (
            <div className="text-[11px] text-muted-foreground border-t pt-2">
              Hardcoded fallback (quando nada está configurado):{' '}
              <code className="font-mono">
                {data.fallback.provider}/{data.fallback.model}
              </code>
              , timeout {data.fallback.timeoutMs}ms, janela {data.fallback.historyWindow},
              min tokens {data.fallback.minInputTokens}.
            </div>
          )}

          <div className="flex items-center gap-3 pt-1">
            <Button onClick={save} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
              Salvar
            </Button>
            {savedAt && <span className="text-xs text-muted-foreground">Salvo.</span>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
