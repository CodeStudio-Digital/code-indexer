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
import { FileText, Globe, Loader2, RefreshCcw, Trash2 } from 'lucide-react';
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
      title: 'Excluir source?',
      description: `${src.uri}\n\n${src.chunk_count} chunks serão removidos.`,
      variant: 'destructive',
      confirmLabel: 'Excluir',
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
          title: 'Source excluído (vetores em fila)',
          description:
            `${result.queued_for_retry} vetor(es) não puderam ser removidos do índice remoto agora ` +
            `e ficaram em fila para retry automático no próximo boot do servidor.`,
        });
      } else if (result.remote_deleted > 0) {
        void notify({
          title: 'Source excluído',
          description: `${result.remote_deleted} vetor(es) removidos do índice remoto.`,
        });
      }
    } catch (e) {
      void notify({
        title: 'Falha ao excluir',
        description: (e as Error).message,
        variant: 'destructive',
      });
    }
  }

  function onReindex(src: DocSource) {
    if (src.type !== 'url') {
      void notify({
        title: 'Re-index indisponível',
        description:
          'PDFs precisam ser re-enviados — o binário não fica armazenado no servidor.',
      });
      return;
    }
    setActiveStream({ sourceId: src.id, kind: 'reindex' });
  }

  if (sources === null) {
    return <div className="text-xs text-muted-foreground italic">Carregando sources…</div>;
  }
  if (sources.length === 0) {
    return (
      <div className="rounded-md border border-dashed bg-muted/20 p-8 text-center text-sm text-muted-foreground">
        Nenhuma source ainda. Clique em <strong>+ Adicionar</strong> acima para colar uma URL ou
        arrastar um PDF.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="text-left px-3 py-2">Source</th>
              <th className="text-left px-3 py-2 w-20">Status</th>
              <th className="text-right px-3 py-2 w-20">Chunks</th>
              <th className="text-right px-3 py-2 w-32">Páginas</th>
              <th className="text-right px-3 py-2 w-44">Última indexação</th>
              <th className="text-right px-3 py-2 w-32">Ações</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => (
              <tr key={s.id} className="border-t hover:bg-muted/20">
                <td className="px-3 py-2 align-top max-w-0">
                  <div className="flex items-start gap-2">
                    {s.type === 'pdf' ? (
                      <FileText className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                    ) : (
                      <Globe className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                    )}
                    <div className="min-w-0">
                      <div className="font-medium truncate">{s.title ?? prettyUri(s.uri)}</div>
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
                            title: 'Forçar re-embed?',
                            description:
                              'Vai apagar TODO o mapping de vetores deste source no SQLite e re-embedar do zero. ' +
                              'Use quando você suspeita que o vector store remoto rejeitou silenciosamente os upserts anteriores ' +
                              '(badge verde mas a busca retorna 0 mesmo em queries que deveriam matchar). ' +
                              'Os chunks textuais ficam intactos — só re-roda embed + upsert.',
                            confirmLabel: 'Forçar re-embed',
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
                    {s.type === 'url' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Re-indexar"
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
                    <Button size="sm" variant="ghost" title="Excluir" onClick={() => void onDelete(s)}>
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
          ✓ {health.chunks_embedded}/{health.chunks_persisted} embedded
        </Badge>
        <Button
          size="sm"
          variant="ghost"
          className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
          onClick={() => onStartForceRetry(source.id)}
          title="Forçar re-embed (wipe + retry) — use quando a busca retorna 0 apesar do badge verde (upsert remoto rejeitado silenciosamente)."
        >
          Forçar re-embed
        </Button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5 mt-1">
      <Badge
        variant="outline"
        className="text-[10px] border-amber-500 text-amber-600"
        title={`${health.missing_count} chunk(s) sem vetor no índice remoto.`}
      >
        ⚠ {health.chunks_embedded}/{health.chunks_persisted} embedded ({health.missing_count} faltando)
      </Badge>
      <Button
        size="sm"
        variant="ghost"
        className="h-5 px-2 text-[10px] text-amber-600 hover:text-amber-700"
        onClick={() => onStartRetry(source.id)}
        title="Embeddar só os chunks faltantes (sem re-fetchar a página)"
      >
        Re-embedar
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
        {PHASE_LABEL[snapshot.phase]}: {snapshot.current}/{snapshot.total}
        {snapshot.pages_via_browser != null && snapshot.pages_via_browser > 0 && (
          <span className="ml-2 text-amber-600">· {snapshot.pages_via_browser} via browser</span>
        )}
      </div>
    </div>
  );
}
