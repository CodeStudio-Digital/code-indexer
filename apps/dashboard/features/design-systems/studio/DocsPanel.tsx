/**
 * Rail do DS Studio — aba Docs: o docs.md da última versão publicada.
 * O agente mantém `pkg/docs.md` no workspace; aqui aparece o snapshot
 * congelado em cada publish.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { fetchVersionDocs, type DesignSystemSessionDetail } from '../design-system-api.js';

export function DocsPanel({ detail }: { detail: DesignSystemSessionDetail }) {
  const { t } = useTranslation('designSystems');
  const [md, setMd] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const published = detail.latest_published;

  useEffect(() => {
    if (!published) {
      setMd(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const text = await fetchVersionDocs(detail.session.id, published.semver);
        if (!cancelled) {
          setMd(text);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [detail.session.id, published?.id, published?.semver]);

  if (!published) {
    return (
      <div className="m-3 rounded border border-dashed p-4 text-center text-xs text-muted-foreground">
        {t('docs.empty')}
      </div>
    );
  }
  if (error) return <div className="m-3 text-xs text-red-600">{error}</div>;
  if (md == null) {
    return (
      <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('loading')}
      </div>
    );
  }
  if (md.trim() === '') {
    return (
      <div className="m-3 rounded border border-dashed p-4 text-center text-xs text-muted-foreground">
        {t('docs.none')}
      </div>
    );
  }
  return (
    <pre className="m-3 max-h-full overflow-auto whitespace-pre-wrap break-words rounded border bg-muted/20 p-2 text-xs">
      {md}
    </pre>
  );
}
