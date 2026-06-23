/**
 * SourceList — per-collection table of `doc_sources` rows.
 *
 * Each row shows the source URL/PDF, status badge, counts, last index time,
 * and per-row actions (re-index, delete). Re-index opens a live SSE drawer
 * via `IndexProgressStream` so the user sees the page-by-page progress.
 *
 * PDF sources can't be re-indexed without a fresh upload — the binary is
 * not retained server-side. The action button hides itself in that case.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, Folder, Globe, Loader2, RefreshCcw, Trash2 } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { useConfirm, useNotify } from '../../components/ui/dialog-provider.js';
import {
  deleteSource,
  reindexSourceStream,
  retrySourceEmbeddingsStream,
  type DocCollection,
  type DocSource,
} from './docs-api.js';
import { IndexProgressStream } from './IndexProgressStream.js';
import { useSourceProgress } from './useSourceProgress.js';
import { useSourceHealth } from './useSourceHealth.js';
import { PHASE_LABEL } from './progress-labels.js';

interface Props {
  collection: DocCollection;
  sources: DocSource[] | null;
  onChanged: () => void | Promise<void>;
}

export function SourceList({ collection, sources, onChanged }: Props) {
  const { t } = useTranslation('docs');
  const confirm = useConfirm();
  const notify = useNotify();
  // `kind: 'reindex'` re-runs the whole pipeline (fetch → gate → chunk
  // → enrich → embed) and replaces existing chunks. `kind: 'retry-embed'`
  // only fills the missing embeddings (preserves the 99% that already
  // worked — primary recovery path for the "stuck at N/M" scenario).
  // `force: true` wipes existing `doc_chunk_vectors` + nulls
  // `embedding_hash` BEFORE retrying — for the "badge says embedded
  // but search returns 0" case (remote vector store silently rejected
  // earlier upserts).
  const [activeStream, setActiveStream] = useState<
    { sourceId: number; kind: 'reindex' | 'retry-embed'; force?: boolean } | null
  >(null);

  async function onDelete(src: DocSource) {
    const ok = await confirm({
      title: t('sources.deleteConfirmTitle'),
      description: t('sources.deleteConfirmDescription', { uri: src.uri, count: src.chunk_count }),
      variant: 'destructive',
      confirmLabel: t('sources.deleteConfirmLabel'),
    });
    if (!ok) return;
    try {
      const result = await deleteSource(collection.id, src.id);
      await onChanged();
      // Only surface a follow-up notify when something interesting
      // happened with the remote vector store. The "everything worked"
      // case (or "nothing to delete") stays silent — the row disappearing
      // from the table is already the confirmation.
      if (result.queued_for_retry > 0) {
        void notify({
          title: t('sources.deletedQueuedTitle'),
          description: t('sources.deletedQueuedDescription', { count: result.queued_for_retry }),
        });
      } else if (result.remote_deleted > 0) {
        void notify({
          title: t('sources.deletedTitle'),
          description: t('sources.deletedDescription', { count: result.remote_deleted }),
        });
      }
    } catch (e) {
      void notify({
        title: t('sources.deleteFailedTitle'),
        description: (e as Error).message,
        variant: 'destructive',
      });
    }
  }

  function onReindex(src: DocSource) {
    // Re-index é suportado para url + folder; PDF precisa de re-upload
    // (binário não fica retido no servidor).
    if (src.type === 'pdf') {
      void notify({
        title: t('sources.reindexUnavailableTitle'),
        description: t('sources.reindexUnavailableDescription'),
      });
      return;
    }
    setActiveStream({ sourceId: src.id, kind: 'reindex' });
  }

  if (sources === null) {
    return <div className="text-xs text-muted-foreground italic">{t('sources.loading')}</div>;
  }
  if (sources.length === 0) {
    return (
      <div className="rounded-md border border-dashed bg-muted/20 p-8 text-center text-sm text-muted-foreground">
        {t('sources.emptyPrefix')} <strong>{t('sources.emptyAction')}</strong> {t('sources.emptySuffix')}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="text-left px-3 py-2">{t('sources.columnSource')}</th>
              <th className="text-left px-3 py-2 w-20">{t('sources.columnStatus')}</th>
              <th className="text-right px-3 py-2 w-20">{t('sources.columnChunks')}</th>
              <th className="text-right px-3 py-2 w-32">{t('sources.columnPages')}</th>
              <th className="text-right px-3 py-2 w-44">{t('sources.columnLastIndexed')}</th>
              <th className="text-right px-3 py-2 w-32">{t('sources.columnActions')}</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => (
              <tr key={s.id} className="border-t hover:bg-muted/20">
                <td className="px-3 py-2 align-top max-w-0">
                  <div className="flex items-start gap-2">
                    {s.type === 'pdf' ? (
                      <FileText className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                    ) : s.type === 'folder' ? (
                      <Folder className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                    ) : (
                      <Globe className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                    )}
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium truncate">{s.title ?? prettyUri(s.uri)}</span>
                        {s.doc_type && s.doc_type !== 'mixed' && (
                          <Badge variant="outline" className="text-[9px] shrink-0 font-normal">
                            {t(`addSource.docTypes.${s.doc_type}`)}
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">{s.uri}</div>
                      {s.error_message && (
                        <div className="text-xs text-destructive mt-0.5">{s.error_message}</div>
                      )}
                      <SourceLiveProgress source={s} />
                      <SourceHealthBadge
                        source={s}
                        onStartRetry={(sourceId) =>
                          setActiveStream({ sourceId, kind: 'retry-embed' })
                        }
                        onStartForceRetry={async (sourceId) => {
                          const ok = await confirm({
                            title: t('sources.forceReembedTitle'),
                            description: t('sources.forceReembedDescription'),
                            confirmLabel: t('sources.forceReembedConfirm'),
                          });
                          if (!ok) return;
                          setActiveStream({ sourceId, kind: 'retry-embed', force: true });
                        }}
                      />
                    </div>
                  </div>
                </td>
                <td className="px-3 py-2 align-top"><SourceStatusBadge status={s.status} /></td>
                <td className="px-3 py-2 text-right align-top tabular-nums">{s.chunk_count}</td>
                <td className="px-3 py-2 text-right align-top text-xs text-muted-foreground tabular-nums">
                  {s.pages_accepted}/{s.page_count}
                </td>
                <td className="px-3 py-2 text-right align-top text-xs text-muted-foreground">
                  {s.last_indexed_at ? new Date(s.last_indexed_at).toLocaleString() : '—'}
                </td>
                <td className="px-3 py-2 text-right align-top">
                  <div className="flex items-center justify-end gap-1">
                    {(s.type === 'url' || s.type === 'folder') && (
                      <Button
                        size="sm"
                        variant="ghost"
                        title={t('sources.actionsReindexTitle')}
                        onClick={() => onReindex(s)}
                        disabled={s.status === 'fetching' || s.status === 'indexing'}
                      >
                        {s.status === 'fetching' || s.status === 'indexing' ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <RefreshCcw className="h-3 w-3" />
                        )}
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" title={t('sources.actionsDeleteTitle')} onClick={() => void onDelete(s)}>
                      <Trash2 className="h-3 w-3 text-red-500" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {activeStream && (
        <IndexProgressStream
          start={(cb) =>
            activeStream.kind === 'retry-embed'
              ? retrySourceEmbeddingsStream(activeStream.sourceId, cb, { force: activeStream.force })
              : reindexSourceStream(collection.id, activeStream.sourceId, cb)
          }
          onClose={async () => {
            setActiveStream(null);
            await onChanged();
          }}
        />
      )}
    </div>
  );
}

function SourceStatusBadge({ status }: { status: DocSource['status'] }) {
  const map: Record<DocSource['status'], { label: string; className: string }> = {
    queued:   { label: 'queued',   className: '' },
    fetching: { label: 'fetching', className: 'border-amber-500 text-amber-600' },
    indexing: { label: 'indexing', className: 'border-amber-500 text-amber-600' },
    done:     { label: 'done',     className: 'border-emerald-500 text-emerald-600' },
    error:    { label: 'error',    className: 'border-destructive text-destructive' },
  };
  const meta = map[status];
  const isLive = status === 'fetching' || status === 'indexing';
  return (
    <Badge variant="outline" className={`text-[10px] ${meta.className}`}>
      {isLive && <Loader2 className="h-2.5 w-2.5 mr-0.5 animate-spin" />}
      {meta.label}
    </Badge>
  );
}

function prettyUri(uri: string): string {
  try {
    if (uri.startsWith('pdf://')) return uri.slice('pdf://'.length);
    // folder://<absolute path> — extrai a parte final do path pra dar
    // economia visual ("…\Documentation\en\ScriptReference" em vez do
    // path inteiro). O `s.uri` completo ainda aparece na linha de baixo
    // (text-xs) pra debugar.
    if (uri.startsWith('folder://')) {
      const fullPath = uri.slice('folder://'.length);
      const segments = fullPath.split(/[\\/]/).filter(Boolean);
      const tail = segments.slice(-3).join('/');
      return tail ? `…/${tail}` : fullPath;
    }
    const u = new URL(uri);
    return `${u.host}${u.pathname}`;
  } catch {
    return uri;
  }
}

/**
 * Post-completion health badge: green when every persisted chunk has an
 * embedding registered, amber when there's drift (vector store crash,
 * embedder hung partway, manual deletion in the remote store). Hidden
 * while the source is still active (the live progress bar handles that).
 *
 * In amber state, also exposes a "Re-embedar" action that opens the
 * `IndexProgressStream` dialog against the per-source retry endpoint.
 */
function SourceHealthBadge({
  source,
  onStartRetry,
  onStartForceRetry,
}: {
  source: DocSource;
  onStartRetry: (sourceId: number) => void;
  onStartForceRetry: (sourceId: number) => void;
}) {
  const { t } = useTranslation('docs');
  const active = source.status === 'fetching' || source.status === 'indexing';
  const { health, refetch } = useSourceHealth(source.id, active ? '' : source.updated_at);
  // Refresh on demand after the retry stream's onClose lands. The caller
  // can also call refetch via a ref, but the cacheBuster on updated_at
  // covers most cases — the parent reloads the list after the stream.
  void refetch;
  if (active || !health || health.chunks_persisted === 0) return null;
  if (health.embedding_complete) {
    return (
      <div className="flex items-center gap-1.5 mt-1">
        <Badge
          variant="outline"
          className="text-[10px] border-emerald-500 text-emerald-600"
        >
          {t('sources.embeddedComplete', { count: health.chunks_embedded, total: health.chunks_persisted })}
        </Badge>
        <Button
          size="sm"
          variant="ghost"
          className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
          onClick={() => onStartForceRetry(source.id)}
          title={t('sources.forceReembedActionTitle')}
        >
          {t('sources.forceReembedAction')}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5 mt-1">
      <Badge
        variant="outline"
        className="text-[10px] border-amber-500 text-amber-600"
        title={t('sources.embeddedMissingTooltip', { count: health.missing_count })}
      >
        {t('sources.embeddedMissing', {
          count: health.chunks_embedded,
          total: health.chunks_persisted,
          missing: health.missing_count,
        })}
      </Badge>
      <Button
        size="sm"
        variant="ghost"
        className="h-5 px-2 text-[10px] text-amber-600 hover:text-amber-700"
        onClick={() => onStartRetry(source.id)}
        title={t('sources.reembedActionTitle')}
      >
        {t('sources.reembedAction')}
      </Button>
    </div>
  );
}

/**
 * Inline live-progress strip under the source URL. Polls the server's
 * progress tracker every 2s while the row is in an active state.
 * Renders nothing when there's no snapshot yet OR when the row is
 * already terminal (the row's status badge + chunk counts cover that).
 */
function SourceLiveProgress({ source }: { source: DocSource }) {
  const { t } = useTranslation('docs');
  const active = source.status === 'fetching' || source.status === 'indexing';
  const snapshot = useSourceProgress(source.id, active);
  if (!active || !snapshot) return null;
  const percent = snapshot.total > 0
    ? Math.min(100, Math.round((snapshot.current / snapshot.total) * 100))
    : 0;
  return (
    <div className="mt-1.5 space-y-0.5">
      <div className="h-1 bg-muted rounded overflow-hidden">
        <div
          className="h-full bg-amber-500 transition-[width] duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="text-[10px] text-muted-foreground tabular-nums">
        {t(PHASE_LABEL[snapshot.phase])}: {snapshot.current}/{snapshot.total}
        {snapshot.pages_via_browser != null && snapshot.pages_via_browser > 0 && (
          <span className="ml-2 text-amber-600">
            · {t('sources.viaBrowser', { count: snapshot.pages_via_browser })}
          </span>
        )}
      </div>
    </div>
  );
}
