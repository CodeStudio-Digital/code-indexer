import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';

/** Mirrors GlobalTelemetrySummary.coverage from the backend (migration 111). */
export interface TelemetryCoverage {
  uncovered_turns: number;
  uncovered_tokens: number;
  total_turns: number;
  uncovered_models: Array<{ model: string; turns: number; tokens: number }>;
}

function formatK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/**
 * Surfaces how much of the estimated cost is missing because some turns ran
 * on models with no resolvable price (cost stored as NULL). Amber banner when
 * there's a gap, a quiet green note when everything is priced.
 */
export function TelemetryCoverageNote({ coverage }: { coverage: TelemetryCoverage | undefined }) {
  const { t } = useTranslation();
  if (!coverage) return null;

  if (coverage.uncovered_turns === 0) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
        {t('telemetry:coverage.allPriced', {
          defaultValue: 'Todos os turnos com uso têm preço — o custo estimado está completo.',
        })}
      </div>
    );
  }

  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
      <div className="flex items-center gap-2 font-medium">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        {t('telemetry:coverage.title', {
          defaultValue: '{{turns}} turno(s) sem preço ({{tokens}} tokens) — fora do custo estimado',
          turns: coverage.uncovered_turns,
          tokens: formatK(coverage.uncovered_tokens),
        })}
      </div>
      {coverage.uncovered_models.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 pl-5 font-mono text-[11px] opacity-90">
          {coverage.uncovered_models.map((m) => (
            <span key={m.model}>
              {m.model} ({formatK(m.tokens)})
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
