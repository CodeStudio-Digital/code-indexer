/**
 * Rail do DS Studio — aba Componentes: lista os componentes registrados
 * (do draft corrente quando existir, senão da última publicada). É o
 * espelho do `ds_record_component` — só entra aqui o que o usuário
 * aprovou no preview.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import {
  listVersionComponents,
  type DesignSystemComponent,
  type DesignSystemSessionDetail,
} from '../design-system-api.js';

export function ComponentsPanel({ detail }: { detail: DesignSystemSessionDetail }) {
  const { t } = useTranslation('designSystems');
  const [components, setComponents] = useState<DesignSystemComponent[] | null>(null);
  const [sourceSemver, setSourceSemver] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Draft aberto tem prioridade (é o trabalho em curso); fallback última publicada.
  const draft = detail.versions.find((v) => v.status === 'draft' || v.status === 'building') ?? null;
  const source = draft ?? detail.latest_published;

  useEffect(() => {
    if (!source) {
      setComponents(null);
      setSourceSemver(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const list = await listVersionComponents(detail.session.id, source.semver);
        if (!cancelled) {
          setComponents(list);
          setSourceSemver(source.semver);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [detail.session.id, source?.id, source?.semver]);

  if (!source) {
    return (
      <div className="m-3 rounded border border-dashed p-4 text-center text-xs text-muted-foreground">
        {t('studio.componentsEmpty')}
      </div>
    );
  }
  if (error) return <div className="m-3 text-xs text-red-600">{error}</div>;
  if (!components) {
    return (
      <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('loading')}
      </div>
    );
  }

  const atoms = components.filter((c) => c.kind === 'atom');
  const pages = components.filter((c) => c.kind === 'page-template');
  return (
    <div className="space-y-3 p-3">
      <div className="text-[11px] text-muted-foreground">
        {t('studio.componentsSource', { semver: sourceSemver ?? '', status: source.status })}
      </div>
      <Group title={t('components.atoms', { count: atoms.length })} components={atoms} />
      <Group title={t('components.pageTemplates', { count: pages.length })} components={pages} />
      {components.length === 0 && (
        <div className="rounded border border-dashed p-4 text-center text-xs text-muted-foreground">
          {t('studio.componentsNoneRecorded')}
        </div>
      )}
    </div>
  );
}

function Group({ title, components }: { title: string; components: DesignSystemComponent[] }) {
  if (components.length === 0) return null;
  return (
    <div>
      <h3 className="mb-1.5 text-xs font-semibold">{title}</h3>
      <ul className="space-y-1.5">
        {components.map((c) => (
          <li key={c.id} className="rounded border p-2">
            <div className="font-mono text-xs">{c.name}</div>
            {c.example_code && (
              <pre className="mt-1 overflow-x-auto rounded bg-muted/40 p-1 text-[11px]">{c.example_code}</pre>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
