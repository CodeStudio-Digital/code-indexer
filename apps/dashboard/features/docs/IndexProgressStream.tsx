/**
 * IndexProgressStream — renders a live SSE feed from an ingestion run.
 *
 * `start(cb)` returns a Promise that resolves on `done` (or rejects on
 * `error`). The component invokes it once on mount, wiring `cb` to local
 * state so the user sees the phase + counts update in real time.
 *
 * The caller decides when the feed is "done" by reading `onClose` — we
 * fire it after either `done` (with the final result) or `error` (with
 * the error message), and let the caller dismiss the surrounding UI.
 */
import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Progress } from '../../components/ui/progress.js';
import type { DocIngestDoneFrame, DocIngestProgressFrame } from './docs-api.js';
import { PHASE_LABEL } from './progress-labels.js';

interface Props {
  start: (cb: {
    onStart?: (p: unknown) => void;
    onProgress?: (p: DocIngestProgressFrame) => void;
    onDone?: (r: DocIngestDoneFrame) => void;
    onError?: (msg: string) => void;
  }) => Promise<void>;
  onClose: () => void | Promise<void>;
}

export function IndexProgressStream({ start, onClose }: Props) {
  const [progress, setProgress] = useState<DocIngestProgressFrame | null>(null);
  const [done, setDone] = useState<DocIngestDoneFrame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(true);

  useEffect(() => {
    let cancelled = false;
    start({
      onProgress: (p) => {
        if (!cancelled) setProgress(p);
      },
      onDone: (r) => {
        if (!cancelled) {
          setDone(r);
          setRunning(false);
        }
      },
      onError: (msg) => {
        if (!cancelled) {
          setError(msg);
          setRunning(false);
        }
      },
    }).catch((err) => {
      if (!cancelled) {
        setError(err instanceof Error ? err.message : String(err));
        setRunning(false);
      }
    });
    return () => {
      cancelled = true;
    };
    // start is intentionally not in deps — re-running on identity change
    // would restart ingestion. The parent controls remount via `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const percent = progress && progress.total > 0
    ? Math.min(100, Math.round((progress.current / progress.total) * 100))
    : 0;

  return (
    <div className="rounded-md border bg-card">
      <div className="px-4 py-3 border-b flex items-center justify-between">
        <div className="flex items-center gap-2">
          {error ? (
            <XCircle className="h-4 w-4 text-destructive" />
          ) : done ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          ) : (
            <Loader2 className="h-4 w-4 animate-spin" />
          )}
          <span className="text-sm font-medium">
            {error
              ? 'Falha na indexação'
              : done
                ? 'Indexação concluída'
                : progress
                  ? PHASE_LABEL[progress.phase]
                  : 'Iniciando…'}
          </span>
        </div>
        <Button size="sm" variant="ghost" disabled={running} onClick={() => void onClose()}>
          Fechar
        </Button>
      </div>
      <div className="px-4 py-3 space-y-3">
        {progress && !done && !error && (
          <>
            <Progress value={percent} className="h-1.5" />
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
              <Stat label="Fase" value={PHASE_LABEL[progress.phase]} />
              <Stat label="Progresso" value={`${progress.current}/${progress.total}`} />
              {progress.pages_fetched != null && (
                <Stat label="Páginas buscadas" value={String(progress.pages_fetched)} />
              )}
              {progress.pages_accepted != null && (
                <Stat
                  label="Aceitas / rejeitadas"
                  value={`${progress.pages_accepted} / ${progress.pages_rejected ?? 0}`}
                />
              )}
              {progress.pages_via_browser != null && progress.pages_via_browser > 0 && (
                <Stat
                  label="Via browser"
                  value={String(progress.pages_via_browser)}
                  hint="Páginas que dispararam bot-detection e foram refetchadas via Chrome headless"
                />
              )}
              {progress.chunks_indexed != null && (
                <Stat label="Chunks" value={String(progress.chunks_indexed)} />
              )}
            </div>
            {progress.label && (
              <div className="text-xs text-muted-foreground truncate">{progress.label}</div>
            )}
          </>
        )}

        {done && (
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
            <Stat label="Chunks indexados" value={String(done.chunks_indexed)} />
            <Stat label="Páginas buscadas" value={String(done.pages_fetched)} />
            <Stat label="Aceitas" value={String(done.pages_accepted)} />
            <Stat label="Rejeitadas" value={String(done.pages_rejected)} />
            {done.pages_via_browser > 0 && (
              <Stat
                label="Via browser"
                value={String(done.pages_via_browser)}
                hint="Páginas que dispararam bot-detection e foram refetchadas via Chrome headless"
              />
            )}
            <Stat label="Tempo" value={`${(done.elapsed_ms / 1000).toFixed(1)}s`} />
            {done.cost_usd > 0 && (
              <Stat label="Custo" value={`$${done.cost_usd.toFixed(4)}`} />
            )}
          </div>
        )}

        {error && (
          <div className="text-sm text-destructive whitespace-pre-wrap break-words">{error}</div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline gap-2" title={hint}>
      <span className="text-muted-foreground">{label}:</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}
