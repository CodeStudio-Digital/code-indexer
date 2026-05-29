import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, Calculator, Loader2, AlertTriangle } from 'lucide-react';
import { useApi, apiPost } from '../../hooks/useApi.js';

interface ModelPriceRow {
  provider: string;
  model_id: string;
  input_per_mtok: number | null;
  output_per_mtok: number | null;
  cache_read_per_mtok: number | null;
  cache_write_per_mtok: number | null;
  currency: string;
  source: string;
  fetched_at: string | null;
  updated_at: string;
}
interface MissingPrice { model: string; provider: string | null; count: number; lastSeenAt: number }
interface SyncResult {
  sources: Array<{ tag: string; ok: boolean; fetched: number; inserted: number; error?: string }>;
  totalRows: number;
  hydrated: boolean;
}
interface BackfillResult { scanned: number; updated: number; nowPriced: number; stillUnpriced: number }

function usd(n: number | null): string {
  if (n == null) return '—';
  if (n === 0) return '$0';
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

const SOURCE_COLORS: Record<string, string> = {
  manual: 'text-purple-600 dark:text-purple-400',
  litellm: 'text-emerald-600 dark:text-emerald-400',
  openrouter: 'text-sky-600 dark:text-sky-400',
  hardcoded: 'text-muted-foreground',
};

// Lower number wins when several sources price the same model — mirrors
// SOURCE_PRIORITY in packages/code-agent/src/providers/pricing-cache.ts.
const SOURCE_PRIORITY: Record<string, number> = { manual: 0, litellm: 1, openrouter: 2, hardcoded: 3 };

export function ModelPricesPanel() {
  const { t } = useTranslation(['telemetry']);
  const { data, loading, error, refetch } = useApi<{ prices: ModelPriceRow[]; missing: MissingPrice[] }>('/admin/model-prices');
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState<null | 'sync' | 'backfill'>(null);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [backfillResult, setBackfillResult] = useState<BackfillResult | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function onSync() {
    setBusy('sync'); setActionError(null); setBackfillResult(null);
    try {
      setSyncResult(await apiPost<SyncResult>('/admin/model-prices/sync', {}));
      refetch();
    } catch (e) { setActionError((e as Error).message); }
    finally { setBusy(null); }
  }
  async function onBackfill() {
    setBusy('backfill'); setActionError(null);
    try {
      setBackfillResult(await apiPost<BackfillResult>('/admin/telemetry/backfill-costs', { dryRun: false }));
    } catch (e) { setActionError((e as Error).message); }
    finally { setBusy(null); }
  }

  const prices = data?.prices ?? [];
  // Which source wins per (provider, model_id) — computed over ALL rows (not
  // the filtered subset) so filtering never changes who's marked active.
  const winnerByKey = new Map<string, string>();
  for (const p of prices) {
    const key = `${p.provider}|${p.model_id}`;
    const cur = winnerByKey.get(key);
    if (cur == null || (SOURCE_PRIORITY[p.source] ?? 99) < (SOURCE_PRIORITY[cur] ?? 99)) {
      winnerByKey.set(key, p.source);
    }
  }
  const f = filter.trim().toLowerCase();
  const filtered = f ? prices.filter((p) => p.model_id.toLowerCase().includes(f) || p.source.toLowerCase().includes(f)) : prices;
  const shown = [...filtered].sort((a, b) => a.model_id.localeCompare(b.model_id)).slice(0, 200);
  const btn = 'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted/50 disabled:opacity-50';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button className={btn} onClick={onSync} disabled={busy !== null}>
          {busy === 'sync' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          {t('telemetry:prices.sync', { defaultValue: 'Sincronizar preços' })}
        </button>
        <button className={btn} onClick={onBackfill} disabled={busy !== null}>
          {busy === 'backfill' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Calculator className="h-3.5 w-3.5" />}
          {t('telemetry:prices.backfill', { defaultValue: 'Recalcular custos (histórico)' })}
        </button>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t('telemetry:prices.filter', { defaultValue: 'Filtrar por modelo / fonte…' })}
          className="ml-auto w-56 rounded-md border bg-background px-2 py-1.5 text-xs"
        />
      </div>

      {actionError && (
        <div className="flex items-center gap-2 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {actionError}
        </div>
      )}
      {syncResult && (
        <div className="rounded-md border bg-card/50 px-3 py-2 text-xs">
          <span className="font-medium">{t('telemetry:prices.syncDone', { defaultValue: 'Sync' })}:</span>{' '}
          {syncResult.sources.map((s) => (
            <span key={s.tag} className="mr-3">
              {s.ok ? `${s.tag}: ${s.inserted}/${s.fetched}` : `${s.tag}: ✗ ${s.error ?? 'erro'}`}
            </span>
          ))}
          <span className="text-muted-foreground">({syncResult.totalRows} linhas)</span>
        </div>
      )}
      {backfillResult && (
        <div className="rounded-md border bg-card/50 px-3 py-2 text-xs">
          <span className="font-medium">{t('telemetry:prices.backfillDone', { defaultValue: 'Backfill' })}:</span>{' '}
          {backfillResult.scanned} escaneados · {backfillResult.updated} atualizados · {backfillResult.nowPriced} com preço · {backfillResult.stillUnpriced} sem preço
        </div>
      )}

      {data?.missing && data.missing.length > 0 && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            {t('telemetry:prices.missingTitle', { defaultValue: 'Modelos vistos sem preço (esta sessão do servidor)' })}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 pl-5 font-mono text-[11px]">
            {data.missing.map((m) => <span key={m.model}>{m.model} ×{m.count}</span>)}
          </div>
        </div>
      )}

      {loading && <div className="text-xs text-muted-foreground">{t('telemetry:prices.loading', { defaultValue: 'Carregando preços…' })}</div>}
      {error && <div className="text-xs text-red-500">{error}</div>}

      {!loading && !error && (
        <div className="rounded-md border bg-card/50">
          <div className="px-3 py-2 border-b">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('telemetry:prices.title', { defaultValue: 'Preços de modelos (USD por 1M tokens)' })}
              {' · '}{filtered.length}{filtered.length > shown.length ? ` (mostrando ${shown.length})` : ''}
            </div>
            <div className="mt-0.5 text-[11px] normal-case text-muted-foreground">
              {t('telemetry:prices.legend', {
                defaultValue: 'Quando há duplicados: manual > litellm > openrouter > hardcoded. ✓ = preço em uso; linhas esmaecidas são ignoradas.',
              })}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-muted/40">
                <tr className="text-left">
                  <th className="px-3 py-2 font-medium">{t('telemetry:prices.model', { defaultValue: 'Modelo' })}</th>
                  <th className="px-3 py-2 text-right font-medium">Input</th>
                  <th className="px-3 py-2 text-right font-medium">Output</th>
                  <th className="px-3 py-2 text-right font-medium">Cache R</th>
                  <th className="px-3 py-2 text-right font-medium">Cache W</th>
                  <th className="px-3 py-2 font-medium">{t('telemetry:prices.source', { defaultValue: 'Fonte' })}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => {
                  const active = winnerByKey.get(`${p.provider}|${p.model_id}`) === p.source;
                  return (
                    <tr
                      key={`${p.provider}|${p.model_id}|${p.source}`}
                      className={`border-t hover:bg-muted/20 ${active ? '' : 'opacity-45'}`}
                    >
                      <td className="px-3 py-2 font-mono">{p.model_id}{p.provider ? ` (${p.provider})` : ''}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{usd(p.input_per_mtok)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{usd(p.output_per_mtok)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{usd(p.cache_read_per_mtok)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{usd(p.cache_write_per_mtok)}</td>
                      <td className={`px-3 py-2 font-mono ${SOURCE_COLORS[p.source] ?? ''}`}>
                        {p.source}{active ? ' ✓' : ''}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
