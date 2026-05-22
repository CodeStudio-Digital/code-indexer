/**
 * "Documentação" — the page mounted at /docs.
 *
 * Three tabs:
 *   - Collections — the original two-pane CRUD over indexed collections.
 *   - Suggestions — auto-discovery (Phase 10 PR 3): scan the active project's
 *                   manifests (package.json, requirements.txt, …) and surface
 *                   doc URLs to approve into collections.
 *   - Research    — converse with the DocsAgent (Phase 10 PR 2): multi-step
 *                   retrieval with citations.
 *
 * Collections are GLOBAL (no project scope) — agents from any project read
 * from the same corpus via the `rag_search_docs` tool. The Suggestions tab,
 * by contrast, scans a SPECIFIC project's manifests, so it exposes its own
 * project picker.
 */
import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { BookOpen } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { CollectionsList } from './CollectionsList.js';
import { CollectionDetail } from './CollectionDetail.js';
import { SuggestionsPanel } from './suggestions/SuggestionsPanel.js';
import { ResearchPanel } from './research/ResearchPanel.js';
import { listCollections, type DocCollection } from './docs-api.js';

interface ProjectOption {
  id: number;
  name: string;
}

export function DocsPage() {
  const { t } = useTranslation('docs');
  const [collections, setCollections] = useState<DocCollection[] | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [pickedProjectId, setPickedProjectId] = useState<number | null>(null);

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

  useEffect(() => {
    let cancelled = false;
    fetch('/api/projects')
      .then((r) => (r.ok ? r.json() : []))
      .then((body: ProjectOption[]) => {
        if (cancelled) return;
        setProjects(body ?? []);
        setPickedProjectId((prev) => prev ?? body?.[0]?.id ?? null);
      })
      .catch(() => {
        /* projects API unavailable — suggestions panel will show "select a project" */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = collections?.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="space-y-6">
      <header className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
          <BookOpen className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">
            <Trans
              t={t}
              i18nKey="subtitle"
              values={{ tool: 'rag_search_docs' }}
              components={{
                tool: <code className="text-xs bg-muted px-1 py-0.5 rounded" />,
              }}
            />
          </p>
        </div>
      </header>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <Tabs defaultValue="collections" className="space-y-4">
        <TabsList>
          <TabsTrigger value="collections">{t('tabs.collections')}</TabsTrigger>
          <TabsTrigger value="suggestions">{t('tabs.suggestions')}</TabsTrigger>
          <TabsTrigger value="research">{t('tabs.research')}</TabsTrigger>
        </TabsList>

        <TabsContent value="collections">
          <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
            <CollectionsList
              collections={collections}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onChanged={reload}
            />
            <CollectionDetail collection={selected} onChanged={reload} />
          </div>
        </TabsContent>

        <TabsContent value="suggestions">
          <div className="space-y-3">
            {projects.length > 0 && (
              <div className="flex items-center gap-2 text-sm">
                <label className="text-muted-foreground">{t('projectPicker.label')}</label>
                <select
                  value={pickedProjectId ?? ''}
                  onChange={(e) => setPickedProjectId(parseInt(e.target.value, 10))}
                  className="h-8 rounded-md border bg-background px-2 text-sm"
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <SuggestionsPanel projectId={pickedProjectId} onChanged={reload} />
          </div>
        </TabsContent>

        <TabsContent value="research">
          <ResearchPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
