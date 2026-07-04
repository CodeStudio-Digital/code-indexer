/**
 * GenParamsCard — a compact inspector summary of the last generation's
 * parameters (seed, variant count, whether the prompt was sent raw). The
 * primary controls live in the center-surface PromptComposer; this card is a
 * read-only mirror so the values are visible while inspecting an asset.
 *
 * Props (mounted by InspectorPanel / the orchestrator):
 *   params: { seed, n, rawPrompt } | null  — last-run params, or null when idle
 */
import { useTranslation } from 'react-i18next';
import { SlidersHorizontal } from 'lucide-react';

export interface GenParamsSummary {
  seed: number | null;
  n: number;
  rawPrompt: boolean;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

export function GenParamsCard({ params }: { params: GenParamsSummary | null }) {
  const { t } = useTranslation('spriteStudio');
  return (
    <div className="space-y-1.5 rounded border p-2">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        <SlidersHorizontal className="h-3.5 w-3.5" />
        {t('generate.params.title')}
      </div>
      {params ? (
        <>
          <Row
            label={t('generate.params.seed')}
            value={params.seed != null ? String(params.seed) : t('generate.params.random')}
          />
          <Row label={t('generate.params.variants')} value={String(params.n)} />
          <Row
            label={t('generate.params.rawPrompt')}
            value={t(params.rawPrompt ? 'generate.params.on' : 'generate.params.off')}
          />
        </>
      ) : (
        <div className="text-[11px] text-muted-foreground">{t('generate.params.empty')}</div>
      )}
    </div>
  );
}
