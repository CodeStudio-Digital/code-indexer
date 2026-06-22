/**
 * DocShell — renders a DocModel as readers see it: branded header, left nav
 * (overview · guides · reference · endpoints grouped by folder) with search, and
 * a content router. PURE (props only) so the same component powers the Studio's
 * live preview AND the future published site. No store, no fetch.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../lib/utils.js';
import { ResearchMarkdown } from '../../docs/research/ResearchMarkdown.js';
import { METHOD_COLOR } from '../collection/row-format.js';
import { ReferenceSection } from './ReferenceSection.js';
import { EndpointView } from './EndpointView.js';
import type { DocModel } from './types.js';

type Sel = { kind: 'overview' } | { kind: 'reference' } | { kind: 'guide'; slug: string } | { kind: 'endpoint'; id: number };

export function DocShell({ model }: { model: DocModel }) {
  const { t } = useTranslation('apiClient');
  const [sel, setSel] = useState<Sel>({ kind: 'overview' });
  const [q, setQ] = useState('');

  const ql = q.trim().toLowerCase();
  const guides = useMemo(() => model.guides.filter((g) => !ql || g.title.toLowerCase().includes(ql)), [model.guides, ql]);
  const endpoints = useMemo(
    () => model.endpoints.filter((e) => !ql || e.name.toLowerCase().includes(ql) || e.path.toLowerCase().includes(ql)),
    [model.endpoints, ql],
  );
  // Group endpoints by folder (preserve folder order from the model, top-level last-less).
  const groups = useMemo(() => {
    const map = new Map<string, typeof endpoints>();
    for (const e of endpoints) { const f = (e.folder ?? '').trim(); if (!map.has(f)) map.set(f, []); map.get(f)!.push(e); }
    return map;
  }, [endpoints]);

  const accent = model.branding.accent;
  const title = model.branding.name || model.meta.title;

  const navBtn = (label: string, on: boolean, onClick: () => void, badge?: number) => (
    <button type="button" onClick={onClick}
      className={cn('w-full text-left px-2 py-1 rounded text-xs flex items-center gap-1.5', on ? 'bg-muted text-foreground font-medium' : 'text-muted-foreground hover:bg-muted/50')}>
      {label}{badge != null && <span className="ml-auto text-[10px]">{badge}</span>}
    </button>
  );

  return (
    <div className="flex flex-col h-full bg-card">
      <header className="h-12 shrink-0 border-b flex items-center gap-2 px-3" style={accent ? { borderBottomColor: accent } : undefined}>
        {model.branding.logoDataUri && <img src={model.branding.logoDataUri} alt="" className="h-6 w-6 rounded object-contain" />}
        <span className="font-semibold text-sm truncate" style={accent ? { color: accent } : undefined}>{title}</span>
        {model.branding.links?.map((l) => (
          <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground hover:text-foreground">{l.label}</a>
        ))}
      </header>
      <div className="flex-1 min-h-0 flex">
        <nav className="w-56 shrink-0 border-r overflow-auto p-2 space-y-0.5">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('docs.searchPlaceholder')}
            className="w-full mb-2 text-xs bg-background border rounded px-2 py-1" />
          {navBtn(t('docs.overview'), sel.kind === 'overview', () => setSel({ kind: 'overview' }))}
          {navBtn(t('docs.reference'), sel.kind === 'reference', () => setSel({ kind: 'reference' }))}
          {guides.length > 0 && <div className="pt-2 pb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{t('docs.guides')}</div>}
          {guides.map((g) => navBtn(g.title, sel.kind === 'guide' && sel.slug === g.slug, () => setSel({ kind: 'guide', slug: g.slug })))}
          {endpoints.length > 0 && <div className="pt-2 pb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{t('docs.endpoints')}</div>}
          {[...groups.entries()].map(([folder, eps]) => (
            <div key={folder || '_top'}>
              {folder && <div className="px-2 pt-1 text-[10px] text-muted-foreground/80">{folder}</div>}
              {eps.map((e) => (
                <button key={e.id} type="button" onClick={() => setSel({ kind: 'endpoint', id: e.id })}
                  className={cn('w-full text-left px-2 py-1 rounded text-xs flex items-center gap-1.5', sel.kind === 'endpoint' && sel.id === e.id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50')}>
                  <span className={cn('font-mono text-[9px] font-semibold w-9 shrink-0', METHOD_COLOR[e.method] ?? '')}>{e.method}</span>
                  <span className="truncate">{e.name}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <main className="flex-1 min-h-0 overflow-auto">
          {sel.kind === 'overview' && (
            <div className="max-w-3xl mx-auto px-6 py-5">
              {model.overview ? <ResearchMarkdown text={model.overview} /> : <p className="text-xs text-muted-foreground italic">{t('docs.emptyOverview')}</p>}
            </div>
          )}
          {sel.kind === 'reference' && <ReferenceSection openapi={model.openapi} />}
          {sel.kind === 'guide' && (() => {
            const g = model.guides.find((x) => x.slug === sel.slug);
            return <div className="max-w-3xl mx-auto px-6 py-5">{g ? <ResearchMarkdown text={g.body} /> : null}</div>;
          })()}
          {sel.kind === 'endpoint' && (() => {
            const e = model.endpoints.find((x) => x.id === sel.id);
            return e ? <EndpointView endpoint={e} /> : null;
          })()}
        </main>
      </div>
    </div>
  );
}
