/**
 * "Documentação" — the page mounted at /docs.
 *
 * Two-pane layout:
 *   ┌──────────────────────────────────────────────┐
 *   │ Collections list │       Collection detail   │
 *   │   - create       │   - sources / search tabs │
 *   │   - select       │   - per-collection actions│
 *   └──────────────────────────────────────────────┘
 *
 * Collections are GLOBAL (no project scope) — agents from any project read
 * from the same corpus via the `rag_search_docs` tool.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BookOpen } from 'lucide-react';
import { CollectionsList } from './CollectionsList.js';
import { CollectionDetail } from './CollectionDetail.js';
import { listCollections, type DocCollection } from './docs-api.js';

export function DocsPage() {
  const { t } = useTranslation();
  const [collections, setCollections] = useState<DocCollection[] | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    try {
      const all = await listCollections();
      setCollections(all);
      // Keep current selection if still present; else pick the first.
      setSelectedId((prev) => {
        if (prev != null && all.some((c) => c.id === prev)) return prev;
        return all[0]?.id ?? null;
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  const selected = collections?.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="space-y-6">
      <header className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
          <BookOpen className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold">{t('nav.docs')}</h1>
          <p className="text-sm text-muted-foreground">
            Indexed external documentation that any agent can query via{' '}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">rag_search_docs</code>. Add PDFs
            or URLs; the indexer chunks, enriches, and embeds them.
          </p>
        </div>
      </header>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
        <CollectionsList
          collections={collections}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onChanged={reload}
        />
        <CollectionDetail collection={selected} onChanged={reload} />
      </div>
    </div>
  );
}
