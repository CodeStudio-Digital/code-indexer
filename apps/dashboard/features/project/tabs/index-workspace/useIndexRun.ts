/**
 * Ciclo de vida do "Run Index" (extraído da RunsTab).
 *
 * Dispara `POST /index/stream` e move o estado local pelos eventos SSE (feedback
 * rico: done/result/cost quando a aba está montada). MAS a fonte de verdade do
 * progresso ao VIVO é o status store do main: o handler espelha cada frame em
 * `activeRun`, então se o usuário sai da tela e volta (estado local zerado, mas a
 * run do backend continua), re-hidratamos a barra a partir de `useIndexStatus`.
 * É isso que faz "saí e voltei e não sei o que roda" deixar de acontecer.
 */
import { useEffect, useRef, useState } from 'react';
import { useIndexStatus } from '../../../workspace/jetbrains/status-bar/useIndexStatus.js';
import { INITIAL_PROGRESS, type IndexProgressState } from './index-run-types.js';
import { readSseStream } from './sse-stream.js';

export interface IndexRunParams {
  provider?: string;
  model?: string;
  force: boolean;
  concurrent: number;
}

export interface IndexRun {
  progress: IndexProgressState;
  isRunning: boolean;
  startIndex: (params: IndexRunParams) => Promise<void>;
  cancelIndex: () => void;
  resetProgress: () => void;
}

export function useIndexRun(projectId: number): IndexRun {
  const [local, setProgress] = useState<IndexProgressState>(INITIAL_PROGRESS);
  const abortRef = useRef<AbortController | null>(null);
  const status = useIndexStatus(projectId);

  // SoT merge: local state wins whenever this mount is driving (or just drove)
  // the run — it carries the rich terminal feedback. When local is idle but the
  // store reports a live pass (a run started before this mount, or that survived
  // a navigation), hydrate a "running" view from `activeRun`.
  const run = status?.activeRun;
  const progress: IndexProgressState =
    local.status === 'idle' && run
      ? {
          status: 'running',
          current: run.current,
          total: run.total,
          percent: run.total > 0 ? Math.round((run.current / run.total) * 100) : 0,
          currentFile: run.currentFile ?? '',
          elapsedMs: Math.max(0, Date.now() - run.startedAt),
          costUsd: run.costUsd ?? 0,
        }
      : local;
  const isRunning = progress.status === 'starting' || progress.status === 'running';

  // Troca de projeto: zera o progresso LOCAL (a barra/contadores/custo/resultado
  // pertencem ao projeto anterior) e aborta o stream em voo. Sem o reset, a
  // RunSection do novo projeto continuaria exibindo o progresso/erro do antigo
  // (o merge acima só cai no `activeRun` do store quando `local.status==='idle'`).
  // Em mount, `setProgress(INITIAL_PROGRESS)` é no-op (mesma referência → React
  // bail-out), então não atrapalha a re-hidratação a partir de `activeRun`.
  useEffect(() => {
    setProgress(INITIAL_PROGRESS);
    return () => {
      abortRef.current?.abort();
    };
  }, [projectId]);

  function handleEvent(event: string, data: Record<string, unknown>) {
    if (event === 'start') {
      setProgress((p) => ({ ...p, status: 'running' }));
      return;
    }
    if (event === 'progress') {
      setProgress((p) => ({
        ...p,
        status: 'running',
        current: Number(data.current ?? 0),
        total: Number(data.total ?? 0),
        percent: Number(data.percent ?? 0),
        currentFile: String(data.current_file ?? ''),
        elapsedMs: Number(data.elapsed_ms ?? 0),
        costUsd: Number(data.cost_usd ?? 0),
      }));
      return;
    }
    if (event === 'done') {
      setProgress((p) => ({
        ...p,
        status: 'done',
        percent: 100,
        current: Number(data.indexed_files ?? p.current),
        total: Number(data.total_files ?? p.total),
        costUsd: Number(data.cost_usd ?? p.costUsd),
        result: {
          indexed: Number(data.indexed_files ?? 0),
          skipped: Number(data.skipped_files ?? 0),
          errors: Number(data.error_count ?? 0),
          durationMs: Number(data.duration_ms ?? 0),
          costUsd: Number(data.cost_usd ?? 0),
        },
      }));
      return;
    }
    if (event === 'error') {
      setProgress((p) => ({ ...p, status: 'error', message: String(data.message ?? 'Unknown error') }));
    }
  }

  async function startIndex(params: IndexRunParams) {
    if (isRunning) return;
    setProgress({ ...INITIAL_PROGRESS, status: 'starting' });
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch(`/api/projects/${projectId}/index/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: params.provider,
          model: params.model,
          force: params.force,
          concurrent: params.concurrent,
        }),
        signal: ctrl.signal,
      });
      await readSseStream(res, handleEvent);
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        setProgress((p) => ({ ...p, status: 'canceled' }));
      } else {
        setProgress((p) => ({ ...p, status: 'error', message: err instanceof Error ? err.message : String(err) }));
      }
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
    }
  }

  function cancelIndex() {
    abortRef.current?.abort();
  }

  function resetProgress() {
    setProgress(INITIAL_PROGRESS);
  }

  return { progress, isRunning, startIndex, cancelIndex, resetProgress };
}
