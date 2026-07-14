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
 * Collections are GLOBAL for ingestion, but retrieval is project-scoped:
 * linking a collection to a project (CollectionDetail → "Projetos
 * vinculados", or automatically on suggestion approval) makes agent
 * sessions on that project search it first via `rag_search_docs`. The
 * Suggestions tab scans a SPECIFIC project's manifests, so it exposes its
 * own project picker.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BookOpen } from 'lucide-react';
import { Panel, PanelGroup } from 'react-resizable-panels';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import {
  WorkbenchPageHeader,
  WorkbenchResizeHandle,
  WorkbenchShell,
  WorkbenchSurface,
} from '../../components/workbench/index.js';
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
    <WorkbenchShell>
      <Tabs defaultValue="collections" className="flex h-full min-h-0 flex-col">
        <WorkbenchPageHeader
          icon={BookOpen}
          title={t('title')}
          description={t('subtitle', { tool: 'rag_search_docs' })}
        />

        <TabsList className="h-8 w-full shrink-0 justify-start gap-0 rounded-none border-b border-[var(--workbench-border)] bg-[var(--workbench-surface)] p-0">
          {(['collections', 'suggestions', 'research'] as const).map((id) => (
            <TabsTrigger
              key={id}
              value={id}
              className="h-8 rounded-none border-b-2 border-transparent bg-transparent px-3 text-[11px] font-medium text-muted-foreground shadow-none hover:bg-[var(--workbench-hover)] hover:text-foreground data-[state=active]:border-violet-400 data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
            >
              {t(`tabs.${id}`)}
            </TabsTrigger>
          ))}
        </TabsList>

        {error && (
          <div className="mx-1.5 mt-1.5 shrink-0 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        <TabsContent value="collections" className="m-0 min-h-0 flex-1 p-1.5">
          <PanelGroup direction="horizontal" autoSaveId="mcp-docs-collections-horiz">
            <Panel defaultSize={21} minSize={16} maxSize={30}>
              <WorkbenchSurface className="flex h-full flex-col">
                <CollectionsList
                  collections={collections}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onChanged={reload}
                />
              </WorkbenchSurface>
            </Panel>
            <WorkbenchResizeHandle direction="horizontal" />
            <Panel minSize={40}>
              <WorkbenchSurface className="h-full">
                <CollectionDetail collection={selected} onChanged={reload} />
              </WorkbenchSurface>
            </Panel>
          </PanelGroup>
        </TabsContent>

        <TabsContent value="suggestions" className="m-0 min-h-0 flex-1 p-1.5">
          <WorkbenchSurface className="h-full overflow-y-auto p-3">
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
          </WorkbenchSurface>
        </TabsContent>

        <TabsContent value="research" className="m-0 min-h-0 flex-1 p-1.5">
          <WorkbenchSurface className="h-full overflow-y-auto p-3">
            <ResearchPanel />
          </WorkbenchSurface>
        </TabsContent>
      </Tabs>
    </WorkbenchShell>
  );
}
