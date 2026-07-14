import { useMemo, useState } from 'react';
import { Check, CircleAlert, Layers3, Search, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../lib/utils.js';
import { patchAppProductScope, type AppProductCapabilityView, type AppStudioSessionDetail } from '../app-studio-api.js';

const HORIZONS: AppProductCapabilityView['horizon'][] = ['core', 'complete', 'future'];

export function ProductPanel({ detail, onChanged }: {
  detail: AppStudioSessionDetail;
  onChanged: () => void;
}) {
  const { t } = useTranslation('appStudio');
  const product = detail.product;
  const [selectedDomain, setSelectedDomain] = useState(product?.model.domains[0]?.id ?? null);
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const define = detail.workflow.state.phases.find((item) => item.id === 'define');
  const editable = product?.status === 'draft' && (define?.status === 'active' || define?.status === 'attention');
  const capabilities = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (product?.model.capabilities ?? []).filter((item) =>
      (!selectedDomain || item.domain_id === selectedDomain) && (!needle || `${item.name} ${item.description}`.toLowerCase().includes(needle)),
    );
  }, [product, query, selectedDomain]);

  async function toggle(capability: AppProductCapabilityView) {
    if (!product || !editable) return;
    setBusyId(capability.id);
    try {
      await patchAppProductScope(detail.session.id, {
        expected_revision_number: product.revision_number,
        selections: [{ capability_id: capability.id, selected: !capability.selected }],
      });
      onChanged();
    } finally { setBusyId(null); }
  }

  if (!product) {
    return <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center"><Layers3 className="h-8 w-8 text-primary" /><h2 className="font-semibold">{t('product.emptyTitle')}</h2><p className="max-w-lg text-sm text-muted-foreground">{t('workflow.coordinatorOwnsArtifacts')}</p></div>;
  }

  return <div className="flex h-full min-h-0 flex-col">
    <header className="flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-3">
      <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><h1 className="font-semibold">{t('product.title')}</h1><span className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{t(`product.complexity.${product.model.complexity}`)}</span></div><p className="truncate text-xs text-muted-foreground">{product.model.summary}</p></div>
      <div className="flex items-center gap-3 text-xs text-muted-foreground"><span>{product.audit.counts.domains} {t('product.domains')}</span><span>{product.audit.counts.selected}/{product.audit.counts.capabilities} {t('product.capabilities')}</span><span>{product.audit.counts.scenarios} {t('product.scenarios')}</span></div>
    </header>
    <div className="flex min-h-0 flex-1">
      <aside className="w-52 shrink-0 overflow-auto border-r p-2 md:w-64">
        <button className={cn('mb-1 w-full rounded px-2 py-2 text-left text-xs', selectedDomain === null ? 'bg-accent' : 'hover:bg-muted')} onClick={() => setSelectedDomain(null)}>{t('product.allDomains')}</button>
        {product.model.domains.map((domain) => <button key={domain.id} className={cn('mb-1 w-full rounded px-2 py-2 text-left text-xs', selectedDomain === domain.id ? 'bg-accent' : 'hover:bg-muted')} onClick={() => setSelectedDomain(domain.id)}><strong className="block truncate">{domain.name}</strong><span className="text-muted-foreground">{domain.capability_ids.length} {t('product.capabilities')}</span></button>)}
      </aside>
      <main className="min-w-0 flex-1 overflow-auto p-4">
        <div className="relative mb-4"><Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('product.search')} className="h-9 w-full rounded border bg-background pl-9 pr-3 text-sm" /></div>
        {product.audit.counts.open_decisions > 0 && <div className="mb-4 border-l-2 border-amber-500 bg-amber-500/10 px-3 py-2 text-sm"><span className="flex items-center gap-1 font-medium"><CircleAlert className="h-4 w-4" />{t('product.openDecisions', { count: product.audit.counts.open_decisions })}</span>{product.model.decisions.filter((item) => item.status === 'open').map((item) => <p key={item.id} className="mt-1 text-xs text-muted-foreground">{item.question}</p>)}</div>}
        <div className="grid gap-4 xl:grid-cols-3">
          {HORIZONS.map((horizon) => <section key={horizon} className="min-w-0"><div className="mb-2 flex items-center justify-between border-b pb-2"><h2 className="text-xs font-semibold uppercase text-muted-foreground">{t(`product.horizon.${horizon}`)}</h2><span className="text-xs text-muted-foreground">{capabilities.filter((item) => item.horizon === horizon).length}</span></div><div className="space-y-2">{capabilities.filter((item) => item.horizon === horizon).map((capability) => <article key={capability.id} className={cn('rounded border p-3', capability.selected && 'border-primary/40 bg-primary/5')}><div className="flex items-start gap-2"><button type="button" disabled={!editable || busyId === capability.id} onClick={() => void toggle(capability)} className={cn('mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded border', capability.selected && 'border-primary bg-primary text-primary-foreground')} aria-label={capability.selected ? t('product.removeScope') : t('product.addScope')}>{capability.selected && <Check className="h-3.5 w-3.5" />}</button><div className="min-w-0"><h3 className="text-sm font-medium">{capability.name}</h3><p className="mt-1 text-xs text-muted-foreground">{capability.description}</p><div className="mt-2 flex flex-wrap gap-1 text-[10px]"><span className="rounded bg-muted px-1.5 py-0.5">{t(`product.provenance.${capability.provenance}`)}</span>{capability.critical && <span className="flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-700"><ShieldCheck className="h-3 w-3" />{t('product.critical')}</span>}</div></div></div></article>)}</div></section>)}
        </div>
      </main>
    </div>
  </div>;
}
