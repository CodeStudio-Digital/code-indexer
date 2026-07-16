/**
 * CollectionDetail — right pane of the Documentação page.
 *
 * Per-collection workspace with two tabs:
 *   - Sources: add PDFs/URLs, view ingestion status, re-index, delete
 *   - Buscar:  search test panel (validates retrieval quality without
 *              having to spin up an agent)
 *
 * Collection-level destructive actions (delete) live here so the
 * collection list stays purely navigational.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { useConfirm, useNotify } from '../../components/ui/dialog-provider.js';
import { WorkbenchPanelHeader } from '../../components/workbench/index.js';
import {
  deleteCollection,
  listSources,
  type DocCollection,
  type DocSource,
} from './docs-api.js';
import { SourceList } from './SourceList.js';
import { AddSourceDialog } from './AddSourceDialog.js';
import { SearchTestPanel } from './SearchTestPanel.js';
import { ProjectLinks } from './ProjectLinks.js';

interface Props {
  collection: DocCollection | null;
  onChanged: () => void | Promise<void>;
}

export function CollectionDetail({ collection, onChanged }: Props) {
  const { t } = useTranslation('docs');
  const notify = useNotify();
  const confirm = useConfirm();
  const [sources, setSources] = useState<DocSource[] | null>(null);
  const [tab, setTab] = useState('sources');
  const [busy, setBusy] = useState(false);

  async function reload() {
    if (!collection) {
      setSources(null);
      return;
    }
    try {
      setSources(await listSources(collection.id));
    } catch (e) {
      void notify({
        title: t('detail.loadErrorTitle'),
        description: (e as Error).message,
        variant: 'destructive',
      });
    }
  }

  useEffect(() => {
    void reload();
  }, [collection?.id]);

  if (!collection) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--workbench-canvas)] p-8 text-center">
        <div className="max-w-sm text-xs text-muted-foreground">{t('detail.empty')}</div>
      </div>
    );
  }

  async function onDeleteCollection() {
    if (!collection) return;
    const ok = await confirm({
      title: t('detail.deleteConfirmTitle', { name: collection.name }),
      description: t('detail.deleteConfirmDescription'),
      variant: 'destructive',
      confirmLabel: t('detail.deleteConfirmLabel'),
    });
    if (!ok) return;
    setBusy(true);
    try {
      const result = await deleteCollection(collection.id);
      await onChanged();
      if (result.vectors_deleted > 0) {
        void notify({
          title: t('detail.deletedTitle'),
          description: t('detail.deletedDescription', { count: result.vectors_deleted }),
        });
      }
    } catch (e) {
      void notify({
        title: t('detail.deleteFailedTitle'),
        description: (e as Error).message,
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkbenchPanelHeader
        title={collection.name}
        actions={(
          <div className="flex items-center gap-1">
            <span className="mr-1 hidden font-mono text-[10px] text-muted-foreground lg:inline">
              {t('detail.summary', { sources: collection.source_count, chunks: collection.chunk_count })}
            </span>
          <AddSourceDialog
            collection={collection}
            onAdded={async () => {
              await reload();
              await onChanged();
            }}
          />
          <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={onDeleteCollection} disabled={busy}>
            {busy ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Trash2 className="h-3 w-3 mr-1 text-red-500" />}
            {t('detail.delete')}
          </Button>
          </div>
        )}
      />

      {(collection.description || (collection.status === 'error' && collection.status_message)) && (
        <div className="shrink-0 border-b border-[var(--workbench-border)] bg-[var(--workbench-surface)] px-3 py-1.5 text-[11px] text-muted-foreground">
          {collection.description}
          {collection.status === 'error' && collection.status_message && (
            <span className="ml-2 text-destructive">{collection.status_message}</span>
          )}
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="h-8 w-full shrink-0 justify-start gap-0 rounded-none border-b border-[var(--workbench-border)] bg-[var(--workbench-surface)] p-0">
          <TabsTrigger value="sources" className="h-8 rounded-none border-b-2 border-transparent px-3 text-[11px] data-[state=active]:border-violet-400 data-[state=active]:bg-transparent data-[state=active]:shadow-none">{t('detail.tabsSources')}</TabsTrigger>
          <TabsTrigger value="search" className="h-8 rounded-none border-b-2 border-transparent px-3 text-[11px] data-[state=active]:border-violet-400 data-[state=active]:bg-transparent data-[state=active]:shadow-none">{t('detail.tabsSearch')}</TabsTrigger>
        </TabsList>

        <TabsContent value="sources" className="m-0 min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          <ProjectLinks collectionId={collection.id} />
          <SourceList
            collection={collection}
            sources={sources}
            onChanged={async () => {
              await reload();
              await onChanged();
            }}
          />
        </TabsContent>

        <TabsContent value="search" className="m-0 min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          <SearchTestPanel collection={collection} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
