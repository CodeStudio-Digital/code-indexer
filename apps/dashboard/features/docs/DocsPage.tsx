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
import { BookOpen, Info } from 'lucide-react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip.js';
import { cn } from '../../lib/utils.js';
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
    // Full-height IDE-style shell. The title, an info affordance (description
    // on hover) and the tabs all share one compact top band styled like the
    // app's top nav; the active tab's body fills the rest and scrolls on its
    // own. `/docs` opts out of AppShell's outer scroll+padding (see AppShell),
    // so this owns its height; `min-h-0` on flex children is load-bearing.
    <Tabs defaultValue="collections" className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 px-3 h-11 border-b shrink-0">
        <BookOpen className="h-4 w-4 text-primary shrink-0" />
        <span className="text-[13px] font-semibold shrink-0">{t('title')}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t('aboutAria')}
              className="text-muted-foreground/70 hover:text-foreground transition-colors shrink-0"
            >
              <Info className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm leading-relaxed">
            {t('subtitle', { tool: 'rag_search_docs' })}
          </TooltipContent>
        </Tooltip>

        <div className="mx-1 h-4 w-px bg-border shrink-0" />

        <TabsList className="h-auto gap-0.5 bg-transparent p-0">
          {(['collections', 'suggestions', 'research'] as const).map((id) => (
            <TabsTrigger
              key={id}
              value={id}
              className={cn(
                'h-7 rounded px-2 text-xs font-medium text-muted-foreground shadow-none',
                'hover:text-foreground hover:bg-muted',
                'data-[state=active]:bg-accent data-[state=active]:text-accent-foreground data-[state=active]:shadow-none',
              )}
            >
              {t(`tabs.${id}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </header>

      {error && (
        <div className="mx-4 mt-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive shrink-0">
          {error}
        </div>
      )}

      <TabsContent value="collections" className="flex-1 min-h-0 mt-0">
          <PanelGroup direction="horizontal" autoSaveId="mcp-docs-collections-horiz">
            <Panel defaultSize={28} minSize={18} maxSize={42}>
              <div className="h-full overflow-y-auto border-r p-3">
                <CollectionsList
                  collections={collections}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onChanged={reload}
                />
              </div>
            </Panel>
            <PanelResizeHandle className="w-px bg-border hover:bg-primary/40 transition-colors" />
            <Panel minSize={40}>
              <div className="h-full overflow-y-auto p-4">
                <CollectionDetail collection={selected} onChanged={reload} />
              </div>
            </Panel>
          </PanelGroup>
        </TabsContent>

        <TabsContent value="suggestions" className="flex-1 min-h-0 mt-0 overflow-y-auto px-4 pb-4">
          <div className="space-y-3 pt-3">
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

        <TabsContent value="research" className="flex-1 min-h-0 mt-0 overflow-y-auto px-4 pb-4">
          <div className="pt-3">
            <ResearchPanel />
          </div>
        </TabsContent>
      </Tabs>
  );
}
