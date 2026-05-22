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
import {
  deleteCollection,
  listSources,
  type DocCollection,
  type DocSource,
} from './docs-api.js';
import { SourceList } from './SourceList.js';
import { AddSourceDialog } from './AddSourceDialog.js';
import { SearchTestPanel } from './SearchTestPanel.js';

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
      <div className="rounded-md border border-dashed bg-muted/20 p-10 text-center text-sm text-muted-foreground">
        {t('detail.empty')}
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
      if (result.queued_for_retry > 0) {
        void notify({
          title: t('detail.deletedQueuedTitle'),
          description: t('detail.deletedQueuedDescription', { count: result.queued_for_retry }),
        });
      } else if (result.remote_deleted > 0) {
        void notify({
          title: t('detail.deletedTitle'),
          description: t('detail.deletedDescription', { count: result.remote_deleted }),
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
    <div className="space-y-4">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">{collection.name}</h2>
          {collection.description && (
            <p className="text-sm text-muted-foreground mt-1">{collection.description}</p>
          )}
          <div className="text-xs text-muted-foreground mt-1">
            {t('detail.summary', { sources: collection.source_count, chunks: collection.chunk_count })}
          </div>
          {collection.status === 'error' && collection.status_message && (
            <div className="mt-2 text-xs text-destructive">{collection.status_message}</div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <AddSourceDialog
            collection={collection}
            onAdded={async () => {
              await reload();
              await onChanged();
            }}
          />
          <Button size="sm" variant="ghost" onClick={onDeleteCollection} disabled={busy}>
            {busy ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Trash2 className="h-3 w-3 mr-1 text-red-500" />}
            {t('detail.delete')}
          </Button>
        </div>
      </header>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="sources">{t('detail.tabsSources')}</TabsTrigger>
          <TabsTrigger value="search">{t('detail.tabsSearch')}</TabsTrigger>
        </TabsList>

        <TabsContent value="sources" className="space-y-3 mt-3">
          <SourceList
            collection={collection}
            sources={sources}
            onChanged={async () => {
              await reload();
              await onChanged();
            }}
          />
        </TabsContent>

        <TabsContent value="search" className="space-y-3 mt-3">
          <SearchTestPanel collection={collection} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
