import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  CircleStop,
  Database,
  FileCode2,
  Loader2,
  PlayCircle,
  RefreshCw,
  Sparkles,
  XCircle,
} from 'lucide-react';
import { Badge } from '../../../components/ui/badge.js';
import { Button } from '../../../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card.js';
import { Progress } from '../../../components/ui/progress.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select.js';
import { Switch } from '../../../components/ui/switch.js';
import { useApi } from '../../../hooks/useApi.js';
import { cn } from '../../../lib/utils.js';
import type { Run } from '../types.js';

interface RunsTabProps {
  projectId: number;
}

interface DiscoveredModel {
  id: string;
  name?: string;
  provider: string;
}

interface IndexProgressState {
  status: 'idle' | 'starting' | 'running' | 'done' | 'error' | 'canceled';
  current: number;
  total: number;
  percent: number;
  currentFile: string;
  elapsedMs: number;
  costUsd: number;
  message?: string;
  result?: {
    indexed: number;
    skipped: number;
    errors: number;
    durationMs: number;
    costUsd: number;
  };
}

const INITIAL_PROGRESS: IndexProgressState = {
  status: 'idle',
  current: 0,
  total: 0,
  percent: 0,
  currentFile: '',
  elapsedMs: 0,
  costUsd: 0,
};

interface EmbeddingCoverage {
  files_total: number;
  files_embedded: number;
  symbols_total: number;
  symbols_embedded: number;
  symbol_bodies_total: number;
  symbol_bodies_embedded: number;
}

interface EmbeddingProgressState {
  status: 'idle' | 'starting' | 'running' | 'done' | 'error';
  current: number;
  total: number;
  percent: number;
  message?: string;
  result?: { embedded: number; skipped: number; tokens: number };
}

const INITIAL_EMBED_PROGRESS: EmbeddingProgressState = {
  status: 'idle',
  current: 0,
  total: 0,
  percent: 0,
};

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

/**
 * Runs tab — lists historical index runs AND hosts the primary "Run Index"
 * action with a provider/model picker + live SSE progress bar. The backend
 * endpoint POST /api/projects/:id/index/stream pushes {progress, done, error}
 * events that drive the state reducer below.
 */
export function RunsTab({ projectId }: RunsTabProps) {
  const { data: runs, loading, refetch } = useApi<Run[]>(`/projects/${projectId}/runs`);

  // ── Provider/model state ───────────────────────────────────────
  // Single source of truth: /api/models returns EVERY model the backend
  // knows about with a `provider: kind` field. We group by kind client
  // side. Much simpler than juggling /api/coder/providers + a fallback
  // discovery cache — no more empty-models edge cases, no cascading
  // useEffects fighting each other, and `kind` is the same identifier
  // the indexer factory accepts as the `provider` body param.
  const [allModels, setAllModels] = useState<DiscoveredModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [kind, setKind] = useState<string>('');
  const [model, setModel] = useState<string>('');
  const [force, setForce] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    setModelsLoading(true);
    fetch('/api/models')
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: unknown) => {
        if (cancelled) return;
        const list: DiscoveredModel[] = Array.isArray(rows)
          ? rows
              .map((m) => {
                if (!m || typeof m !== 'object') return null;
                const o = m as { id?: unknown; name?: unknown; provider?: unknown };
                const id = typeof o.id === 'string' ? o.id : '';
                const provider = typeof o.provider === 'string' ? o.provider : '';
                if (!id || !provider) return null;
                return {
                  id,
                  provider,
                  name: typeof o.name === 'string' ? o.name : id,
                };
              })
              .filter((m): m is DiscoveredModel => m !== null)
          : [];
        setAllModels(list);
      })
      .catch(() => {
        if (!cancelled) setAllModels([]);
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Unique provider kinds derived from the model list, in the order
  // they first appear (stable).
  const providerKinds = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of allModels) {
      if (!seen.has(m.provider)) {
        seen.add(m.provider);
        out.push(m.provider);
      }
    }
    return out;
  }, [allModels]);

  const availableModels = useMemo(
    () => allModels.filter((m) => m.provider === kind),
    [allModels, kind],
  );

  // Auto-pick first kind once models land.
  useEffect(() => {
    if (!kind && providerKinds.length > 0) setKind(providerKinds[0]);
  }, [providerKinds, kind]);

  // Keep `model` consistent with the selected kind. Whenever the kind
  // changes or the previous model isn't in the new list, snap to the
  // first valid model — this prevents the Radix Select from rendering
  // blank (a controlled empty value does NOT fall back to placeholder).
  useEffect(() => {
    if (availableModels.length === 0) {
      if (model) setModel('');
      return;
    }
    if (!availableModels.some((m) => m.id === model)) {
      setModel(availableModels[0].id);
    }
  }, [availableModels, model]);

  // ── Progress state + SSE controller ────────────────────────────
  const [progress, setProgress] = useState<IndexProgressState>(INITIAL_PROGRESS);
  const abortRef = useRef<AbortController | null>(null);
  const isRunning =
    progress.status === 'starting' || progress.status === 'running';

  useEffect(() => {
    // Cleanup any in-flight stream when the component unmounts / project
    // changes — nothing worse than orphaned fetches.
    return () => {
      abortRef.current?.abort();
    };
  }, [projectId]);

  async function startIndex() {
    if (isRunning) return;
    setProgress({ ...INITIAL_PROGRESS, status: 'starting' });

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const res = await fetch(`/api/projects/${projectId}/index/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // kind is the same identifier the factory's registry accepts
          // (e.g. 'anthropic', 'openai', 'zai'), so the indexer picks
          // the default enabled instance of that kind from the store.
          provider: kind || undefined,
          model: model || undefined,
          force,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const raw of frames) {
          const lines = raw.split('\n');
          let eventName = 'message';
          let dataStr = '';
          for (const ln of lines) {
            if (ln.startsWith('event:')) eventName = ln.slice(6).trim();
            else if (ln.startsWith('data:')) dataStr += ln.slice(5).trim();
          }
          if (!dataStr) continue;
          let data: Record<string, unknown>;
          try {
            data = JSON.parse(dataStr);
          } catch {
            continue;
          }
          handleEvent(eventName, data);
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        setProgress((p) => ({ ...p, status: 'canceled' }));
      } else {
        setProgress((p) => ({
          ...p,
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        }));
      }
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
      // Refresh the historical run list so the newly-completed run shows up.
      refetch();
    }
  }

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
      setProgress((p) => ({
        ...p,
        status: 'error',
        message: String(data.message ?? 'Unknown error'),
      }));
    }
  }

  function cancelIndex() {
    abortRef.current?.abort();
  }

  function resetProgress() {
    setProgress(INITIAL_PROGRESS);
  }

  // ── Embedding retry state ──────────────────────────────────────
  const [coverage, setCoverage] = useState<EmbeddingCoverage | null>(null);
  const [embedProgress, setEmbedProgress] = useState<EmbeddingProgressState>(INITIAL_EMBED_PROGRESS);
  const embedAbortRef = useRef<AbortController | null>(null);
  const isEmbedRunning = embedProgress.status === 'starting' || embedProgress.status === 'running';

  // Fetch coverage on mount and after index/embed runs complete
  const fetchCoverage = () => {
    fetch(`/api/projects/${projectId}/embeddings/stats`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: unknown) => {
        if (data && typeof data === 'object' && 'coverage' in data) {
          setCoverage((data as { coverage: EmbeddingCoverage }).coverage);
        }
      })
      .catch(() => {});
  };

  useEffect(() => {
    fetchCoverage();
  }, [projectId]);

  // Refresh coverage when index run finishes
  useEffect(() => {
    if (progress.status === 'done') fetchCoverage();
  }, [progress.status]);

  async function startEmbeddingRetry() {
    if (isEmbedRunning || isRunning) return;
    setEmbedProgress({ ...INITIAL_EMBED_PROGRESS, status: 'starting' });

    const ctrl = new AbortController();
    embedAbortRef.current = ctrl;

    try {
      const res = await fetch(`/api/projects/${projectId}/embeddings/retry/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const raw of frames) {
          const lines = raw.split('\n');
          let eventName = 'message';
          let dataStr = '';
          for (const ln of lines) {
            if (ln.startsWith('event:')) eventName = ln.slice(6).trim();
            else if (ln.startsWith('data:')) dataStr += ln.slice(5).trim();
          }
          if (!dataStr) continue;
          let data: Record<string, unknown>;
          try { data = JSON.parse(dataStr); } catch { continue; }

          if (eventName === 'start') {
            setEmbedProgress((p) => ({ ...p, status: 'running' }));
          } else if (eventName === 'progress') {
            setEmbedProgress((p) => ({
              ...p,
              status: 'running',
              current: Number(data.current ?? 0),
              total: Number(data.total ?? 0),
              percent: Number(data.percent ?? 0),
            }));
          } else if (eventName === 'done') {
            setEmbedProgress((p) => ({
              ...p,
              status: 'done',
              percent: 100,
              result: {
                embedded: Number(data.embedded ?? 0),
                skipped: Number(data.skipped ?? 0),
                tokens: Number(data.tokens ?? 0),
              },
            }));
          } else if (eventName === 'error') {
            setEmbedProgress((p) => ({
              ...p,
              status: 'error',
              message: String(data.message ?? 'Unknown error'),
            }));
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setEmbedProgress((p) => ({
          ...p,
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        }));
      }
    } finally {
      if (embedAbortRef.current === ctrl) embedAbortRef.current = null;
      fetchCoverage();
    }
  }

  useEffect(() => {
    return () => { embedAbortRef.current?.abort(); };
  }, [projectId]);

  const providerDisabled = !modelsLoading && providerKinds.length === 0;
  const canRun = !isRunning && !!kind && !!model;

  return (
    <div className="space-y-6">
      {/* ── Run Index card ─────────────────────────────────── */}
      <Card className="border-primary/30 bg-gradient-to-br from-primary/5 via-transparent to-transparent">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-primary text-primary-foreground flex items-center justify-center shadow-sm">
                <Sparkles className="h-5 w-5" />
              </div>
              <div>
                <CardTitle className="text-base">Run Index</CardTitle>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Analise o projeto com um provider/modelo LLM e veja o
                  progresso em tempo real.
                </p>
              </div>
            </div>
            <Badge variant={isRunning ? 'warning' : 'muted'}>
              {isRunning
                ? 'running'
                : progress.status === 'done'
                  ? 'done'
                  : progress.status === 'error'
                    ? 'error'
                    : progress.status === 'canceled'
                      ? 'canceled'
                      : 'idle'}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Provider
              </label>
              <Select
                value={kind || undefined}
                onValueChange={(v) => setKind(v)}
                disabled={providerDisabled || isRunning || modelsLoading}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      modelsLoading
                        ? 'Carregando…'
                        : providerDisabled
                          ? 'Configure providers em Admin'
                          : 'Selecione um provider'
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {providerKinds.map((k) => (
                    <SelectItem key={k} value={k}>
                      {k}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Modelo
              </label>
              <Select
                value={model || undefined}
                onValueChange={(v) => setModel(v)}
                disabled={
                  providerDisabled ||
                  isRunning ||
                  modelsLoading ||
                  availableModels.length === 0
                }
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      modelsLoading
                        ? 'Carregando modelos…'
                        : availableModels.length === 0
                          ? 'Nenhum modelo disponível'
                          : 'Selecione um modelo'
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {availableModels.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name || m.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {kind && !modelsLoading && availableModels.length === 0 && (
                <p className="text-xs text-warning">
                  Nenhum modelo cadastrado para <strong>{kind}</strong>.
                  Adicione modelos na aba <strong>Admin</strong>.
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg border bg-card px-3 py-2">
            <div className="flex items-center gap-3">
              <Switch
                checked={force}
                onCheckedChange={setForce}
                disabled={isRunning}
                id="force-reindex"
              />
              <label
                htmlFor="force-reindex"
                className="text-sm cursor-pointer select-none"
              >
                <span className="font-medium">Force re-index</span>
                <span className="text-muted-foreground ml-2 text-xs">
                  Reanalisa arquivos inalterados (mais caro)
                </span>
              </label>
            </div>
          </div>

          {/* Progress block (only when active/finished) */}
          {progress.status !== 'idle' && (
            <div className="rounded-lg border bg-card/80 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-medium">
                  {isRunning && (
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  )}
                  {progress.status === 'done' && (
                    <CheckCircle2 className="h-4 w-4 text-success" />
                  )}
                  {progress.status === 'error' && (
                    <XCircle className="h-4 w-4 text-destructive" />
                  )}
                  {progress.status === 'canceled' && (
                    <CircleStop className="h-4 w-4 text-muted-foreground" />
                  )}
                  <span>
                    {progress.status === 'starting'
                      ? 'Iniciando…'
                      : progress.status === 'running'
                        ? 'Indexando'
                        : progress.status === 'done'
                          ? 'Concluído'
                          : progress.status === 'error'
                            ? 'Erro'
                            : 'Cancelado'}
                  </span>
                </div>
                <div className="text-sm tabular-nums text-muted-foreground">
                  {progress.total > 0
                    ? `${progress.current}/${progress.total}`
                    : '—'}
                  <span className="ml-2 font-medium text-foreground">
                    {progress.percent}%
                  </span>
                </div>
              </div>

              <Progress
                value={progress.percent}
                indeterminate={
                  progress.status === 'starting' ||
                  (progress.status === 'running' && progress.total === 0)
                }
                className={cn(
                  progress.status === 'error' && '[&>div]:bg-destructive',
                  progress.status === 'done' && '[&>div]:bg-success',
                )}
              />

              {progress.currentFile && isRunning && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground truncate">
                  <FileCode2 className="h-3 w-3 shrink-0" />
                  <span className="font-mono truncate">{progress.currentFile}</span>
                </div>
              )}

              <div className="flex items-center gap-4 text-xs text-muted-foreground tabular-nums pt-1 border-t">
                <span>Tempo: {formatDuration(progress.elapsedMs || progress.result?.durationMs || 0)}</span>
                <span>Custo: ${progress.costUsd.toFixed(4)}</span>
                {progress.result && (
                  <>
                    <span>Skipped: {progress.result.skipped}</span>
                    {progress.result.errors > 0 && (
                      <span className="text-destructive">
                        Errors: {progress.result.errors}
                      </span>
                    )}
                  </>
                )}
              </div>

              {progress.status === 'error' && progress.message && (
                <div className="flex gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2">
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>{progress.message}</span>
                </div>
              )}
            </div>
          )}

          <div className="flex items-center gap-2">
            {isRunning ? (
              <Button
                variant="destructive"
                onClick={cancelIndex}
                className="gap-2"
              >
                <CircleStop className="h-4 w-4" /> Cancelar
              </Button>
            ) : (
              <Button
                onClick={startIndex}
                disabled={!canRun}
                className="gap-2"
              >
                <PlayCircle className="h-4 w-4" />
                {progress.status === 'done' ||
                progress.status === 'error' ||
                progress.status === 'canceled'
                  ? 'Rodar de novo'
                  : 'Rodar Index'}
              </Button>
            )}
            {(progress.status === 'done' ||
              progress.status === 'error' ||
              progress.status === 'canceled') && (
              <Button variant="ghost" onClick={resetProgress} className="gap-2">
                <RefreshCw className="h-4 w-4" /> Limpar
              </Button>
            )}
            {providerDisabled && !isRunning && (
              <p className="text-xs text-muted-foreground">
                Configure um provider na aba <strong>Admin</strong> primeiro.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── Embeddings card ─────────────────────────────────── */}
      {coverage && (
        <Card className="border-muted">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-muted text-muted-foreground flex items-center justify-center shadow-sm">
                  <Database className="h-5 w-5" />
                </div>
                <div>
                  <CardTitle className="text-base">Embeddings</CardTitle>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Vetores para busca semântica. Retry re-embeda apenas os
                    registros faltantes.
                  </p>
                </div>
              </div>
              {(() => {
                const total = coverage.files_total + coverage.symbols_total + coverage.symbol_bodies_total;
                const done = coverage.files_embedded + coverage.symbols_embedded + coverage.symbol_bodies_embedded;
                const pct = total > 0 ? Math.round((done / total) * 100) : 100;
                return (
                  <Badge variant={pct >= 100 ? 'success' : pct > 0 ? 'warning' : 'destructive'}>
                    {done}/{total} — {pct}%
                  </Badge>
                );
              })()}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-3 text-sm">
              <div className="rounded-lg border bg-card px-3 py-2">
                <span className="text-muted-foreground text-xs">Files</span>
                <div className="font-medium tabular-nums">
                  {coverage.files_embedded}/{coverage.files_total}
                </div>
              </div>
              <div className="rounded-lg border bg-card px-3 py-2">
                <span className="text-muted-foreground text-xs">Symbols</span>
                <div className="font-medium tabular-nums">
                  {coverage.symbols_embedded}/{coverage.symbols_total}
                </div>
              </div>
              <div className="rounded-lg border bg-card px-3 py-2">
                <span className="text-muted-foreground text-xs">Bodies</span>
                <div className="font-medium tabular-nums">
                  {coverage.symbol_bodies_embedded}/{coverage.symbol_bodies_total}
                </div>
              </div>
            </div>

            {/* Embedding retry progress */}
            {embedProgress.status !== 'idle' && (
              <div className="rounded-lg border bg-card/80 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {isEmbedRunning && (
                      <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    )}
                    {embedProgress.status === 'done' && (
                      <CheckCircle2 className="h-4 w-4 text-success" />
                    )}
                    {embedProgress.status === 'error' && (
                      <XCircle className="h-4 w-4 text-destructive" />
                    )}
                    <span>
                      {embedProgress.status === 'starting'
                        ? 'Iniciando…'
                        : embedProgress.status === 'running'
                          ? 'Embedding'
                          : embedProgress.status === 'done'
                            ? 'Concluido'
                            : 'Erro'}
                    </span>
                  </div>
                  <div className="text-sm tabular-nums text-muted-foreground">
                    {embedProgress.total > 0
                      ? `${embedProgress.current}/${embedProgress.total}`
                      : '—'}
                    <span className="ml-2 font-medium text-foreground">
                      {embedProgress.percent}%
                    </span>
                  </div>
                </div>

                <Progress
                  value={embedProgress.percent}
                  indeterminate={
                    embedProgress.status === 'starting' ||
                    (embedProgress.status === 'running' && embedProgress.total === 0)
                  }
                  className={cn(
                    embedProgress.status === 'error' && '[&>div]:bg-destructive',
                    embedProgress.status === 'done' && '[&>div]:bg-success',
                  )}
                />

                {embedProgress.result && (
                  <div className="flex items-center gap-4 text-xs text-muted-foreground tabular-nums pt-1 border-t">
                    <span>Embedded: {embedProgress.result.embedded}</span>
                    <span>Tokens: {embedProgress.result.tokens.toLocaleString()}</span>
                  </div>
                )}

                {embedProgress.status === 'error' && embedProgress.message && (
                  <div className="flex gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2">
                    <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                    <span>{embedProgress.message}</span>
                  </div>
                )}
              </div>
            )}

            <div className="flex items-center gap-2">
              {isEmbedRunning ? (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => embedAbortRef.current?.abort()}
                  className="gap-2"
                >
                  <CircleStop className="h-4 w-4" /> Cancelar
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={startEmbeddingRetry}
                  disabled={isRunning || isEmbedRunning}
                  className="gap-2"
                >
                  <RefreshCw className="h-4 w-4" />
                  {embedProgress.status === 'done' || embedProgress.status === 'error'
                    ? 'Retry de novo'
                    : 'Retry Embeddings'}
                </Button>
              )}
              {embedProgress.status !== 'idle' && !isEmbedRunning && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setEmbedProgress(INITIAL_EMBED_PROGRESS)}
                  className="gap-2"
                >
                  <RefreshCw className="h-4 w-4" /> Limpar
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Historical runs ───────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Histórico
          </h3>
          <Button
            variant="ghost"
            size="sm"
            onClick={refetch}
            className="h-7 gap-1.5"
          >
            <RefreshCw className="h-3 w-3" /> Atualizar
          </Button>
        </div>
        {loading ? (
          <div className="text-muted-foreground text-sm">Carregando…</div>
        ) : !runs || runs.length === 0 ? (
          <div className="text-muted-foreground text-sm border border-dashed rounded-lg px-4 py-8 text-center">
            Nenhuma run ainda.
          </div>
        ) : (
          <div className="space-y-2">
            {runs.map((r) => (
              <div
                key={r.id}
                className="flex items-center justify-between p-3 rounded-lg border bg-card"
              >
                <div className="flex items-center gap-3">
                  <span
                    className={cn(
                      'h-2 w-2 rounded-full',
                      r.status === 'completed'
                        ? 'bg-success'
                        : r.status === 'running'
                          ? 'bg-warning animate-pulse'
                          : 'bg-destructive',
                    )}
                  />
                  <span className="text-sm font-medium">Run #{r.id}</span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(r.started_at).toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center gap-4 text-sm text-muted-foreground tabular-nums">
                  <span>
                    {r.indexed_files}/{r.total_files} files
                  </span>
                  <span>${r.estimated_cost_usd.toFixed(4)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
