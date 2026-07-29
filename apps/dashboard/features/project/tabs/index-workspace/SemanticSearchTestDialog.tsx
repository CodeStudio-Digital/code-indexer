import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertCircle,
  Braces,
  CheckCircle2,
  ExternalLink,
  FileCode2,
  Loader2,
  Search,
  SlidersHorizontal,
  TerminalSquare,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../../../components/ui/badge.js';
import { Button } from '../../../../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../../../components/ui/dialog.js';
import { ScrollArea } from '../../../../components/ui/scroll-area.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../../components/ui/select.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../../components/ui/tabs.js';
import { Textarea } from '../../../../components/ui/textarea.js';
import {
  recordProjectSemanticOutcome,
  testProjectSemanticSearch,
  type ProjectSemanticSearchInput,
  type ProjectSemanticSearchMode,
  type ProjectSemanticSearchTestResult,
  type ProjectSemanticSearchType,
} from './project-semantic-api.js';
import {
  buildSemanticConsumerPreview,
  SEMANTIC_CONSUMER_DEFAULTS,
  semanticResultLine,
  semanticResultPath,
  type SemanticConsumer,
} from './semantic-search-test.js';

interface SemanticSearchTestDialogProps {
  projectId: number;
  projectName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  remoteInference: boolean;
  onOpenFile?: (path: string) => void;
}

const LIMITS = [5, 10, 20, 40, 50];

function numeric(value?: number): string {
  return value == null ? '—' : value.toLocaleString();
}

function milliseconds(value?: number): string {
  return value == null ? '—' : `${value.toFixed(value < 10 ? 1 : 0)} ms`;
}

export function SemanticSearchTestDialog({
  projectId,
  projectName,
  open,
  onOpenChange,
  remoteInference,
  onOpenFile,
}: SemanticSearchTestDialogProps) {
  const { t } = useTranslation('projects');
  const [query, setQuery] = useState('');
  const [consumer, setConsumer] = useState<SemanticConsumer>('pipeline');
  const [mode, setMode] = useState<ProjectSemanticSearchMode>('hybrid');
  const [type, setType] = useState<ProjectSemanticSearchType>('all');
  const [limit, setLimit] = useState(10);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<ProjectSemanticSearchTestResult | null>(null);
  const [lexicalResponse, setLexicalResponse] =
    useState<ProjectSemanticSearchTestResult | null>(null);
  const [executedInput, setExecutedInput] = useState<ProjectSemanticSearchInput | null>(null);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!open) controller.current?.abort();
  }, [open]);

  const selectConsumer = (next: SemanticConsumer) => {
    setConsumer(next);
    const defaults = SEMANTIC_CONSUMER_DEFAULTS[next];
    setMode(defaults.mode);
    setType(defaults.type);
    setLimit(defaults.limit);
  };

  const run = async () => {
    const trimmed = query.trim();
    if (!trimmed) return;
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    const input: ProjectSemanticSearchInput = { query: trimmed, mode, type, limit };
    setLoading(true);
    setError(null);
    try {
      const lexical = mode === 'fts'
        ? null
        : await testProjectSemanticSearch(
            projectId,
            { ...input, mode: 'fts' },
            nextController.signal,
          );
      if (nextController.signal.aborted) return;
      const next = await testProjectSemanticSearch(projectId, input, nextController.signal);
      if (nextController.signal.aborted) return;
      setLexicalResponse(lexical);
      setResponse(next);
      setExecutedInput(input);
    } catch (cause) {
      if (nextController.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setResponse(null);
      setLexicalResponse(null);
      setExecutedInput(null);
    } finally {
      if (controller.current === nextController) setLoading(false);
    }
  };

  const preview = useMemo(() => response && executedInput
    ? buildSemanticConsumerPreview(consumer, projectId, projectName, executedInput, response)
    : '', [consumer, executedInput, projectId, projectName, response]);
  const diagnostics = response?.diagnostics ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[88vh] max-h-[900px] w-[min(1120px,calc(100vw-2rem))] max-w-none flex-col overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b px-6 py-5 pr-12">
          <DialogTitle className="flex items-center gap-2">
            <Search className="h-5 w-5 text-violet-400" />
            {t('index.semanticTest.title')}
          </DialogTitle>
          <DialogDescription>{t('index.semanticTest.description')}</DialogDescription>
        </DialogHeader>

        <div className="shrink-0 space-y-3 border-b bg-muted/10 px-6 py-4">
          {remoteInference ? (
            <div className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-400">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              {t('index.semanticTest.remoteWarning')}
            </div>
          ) : null}
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_190px_130px_130px_90px]">
            <div className="space-y-1.5">
              <label htmlFor="semantic-test-query" className="text-sm font-medium leading-none">{t('index.semanticTest.query')}</label>
              <Textarea
                id="semantic-test-query"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void run();
                }}
                placeholder={t('index.semanticTest.queryPlaceholder')}
                className="min-h-20"
                autoFocus
              />
            </div>
            <Field label={t('index.semanticTest.simulate')}>
              <Select value={consumer} onValueChange={(value) => selectConsumer(value as SemanticConsumer)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="pipeline">{t('index.semanticTest.consumer.pipeline')}</SelectItem>
                  <SelectItem value="mcp">{t('index.semanticTest.consumer.mcp')}</SelectItem>
                  <SelectItem value="agent">{t('index.semanticTest.consumer.agent')}</SelectItem>
                  <SelectItem value="monaco">{t('index.semanticTest.consumer.monaco')}</SelectItem>
                  <SelectItem value="search_everywhere">{t('index.semanticTest.consumer.searchEverywhere')}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label={t('index.semanticTest.mode')}>
              <Select value={mode} onValueChange={(value) => setMode(value as ProjectSemanticSearchMode)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{t('index.semanticTest.modeAuto')}</SelectItem>
                  <SelectItem value="hybrid">{t('index.semanticTest.modeHybrid')}</SelectItem>
                  <SelectItem value="vector">{t('index.semanticTest.modeVector')}</SelectItem>
                  <SelectItem value="fts">{t('index.semanticTest.modeFts')}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label={t('index.semanticTest.type')}>
              <Select value={type} onValueChange={(value) => setType(value as ProjectSemanticSearchType)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('index.semanticTest.typeAll')}</SelectItem>
                  <SelectItem value="files">{t('index.semanticTest.typeFiles')}</SelectItem>
                  <SelectItem value="symbols">{t('index.semanticTest.typeSymbols')}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label={t('index.semanticTest.topK')}>
              <Select value={String(limit)} onValueChange={(value) => setLimit(Number(value))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {LIMITS.map((value) => <SelectItem key={value} value={String(value)}>{value}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">{t('index.semanticTest.cacheHint')}</p>
            <Button type="button" onClick={() => void run()} disabled={loading || !query.trim()}>
              {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}
              {loading ? t('index.semanticTest.running') : t('index.semanticTest.run')}
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 px-6 pb-5">
          {error ? (
            <div className="mt-4 flex gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" /> {error}
            </div>
          ) : null}
          {!response && !error && !loading ? (
            <div className="grid h-full place-items-center text-center text-sm text-muted-foreground">
              <div className="max-w-md space-y-2">
                <SlidersHorizontal className="mx-auto h-8 w-8 opacity-50" />
                <p>{t('index.semanticTest.empty')}</p>
              </div>
            </div>
          ) : null}
          {response ? (
            <Tabs defaultValue="results" className="flex h-full min-h-0 flex-col pt-4">
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
                <TabsList>
                  <TabsTrigger value="results"><FileCode2 /> {t('index.semanticTest.results')} ({response.results.length})</TabsTrigger>
                  <TabsTrigger value="pipeline"><SlidersHorizontal /> {t('index.semanticTest.pipeline')}</TabsTrigger>
                  <TabsTrigger value="consumer"><TerminalSquare /> {t('index.semanticTest.preview')}</TabsTrigger>
                </TabsList>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge variant="secondary">{diagnostics?.plannedMode ?? '—'} → {diagnostics?.effectiveMode ?? '—'}</Badge>
                  <Badge variant={diagnostics?.rerankerApplied ? 'success' : 'muted'}>
                    {diagnostics?.rerankerApplied
                      ? t('index.semanticTest.rerankerApplied')
                      : t('index.semanticTest.rrfPreserved')}
                  </Badge>
                  <Badge variant="muted">{milliseconds(diagnostics?.totalTimeMs)}</Badge>
                </div>
              </div>

              <TabsContent value="results" className="min-h-0 flex-1">
                <ScrollArea className="h-full pr-3">
                  <div className="space-y-2 pb-2">
                    {lexicalResponse ? (
                      <div className="mb-3 grid gap-3 lg:grid-cols-2">
                        <SearchTopFive
                          title="Baseline lexical (FTS)"
                          response={lexicalResponse}
                        />
                        <SearchTopFive
                          title={`Resultado ${diagnostics?.effectiveMode ?? mode}`}
                          response={response}
                          compareAgainst={lexicalResponse}
                        />
                      </div>
                    ) : null}
                    {response.results.map((result, index) => {
                      const path = semanticResultPath(result);
                      const line = semanticResultLine(result);
                      return (
                        <div key={`${result.type}:${result.id}`} className="rounded-lg border bg-muted/10 p-3">
                          <div className="flex items-start gap-3">
                            <span className="w-6 shrink-0 pt-0.5 text-right text-xs tabular-nums text-muted-foreground">#{index + 1}</span>
                            <div className="min-w-0 flex-1 space-y-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <Badge variant={result.type === 'symbol' ? 'secondary' : 'info'}>{result.type}</Badge>
                                <span className="truncate font-mono text-sm">{path}{line ? `:${line}` : ''}</span>
                                {result.type === 'symbol' && result.data.name ? <strong className="text-sm">{result.data.name}</strong> : null}
                              </div>
                              {result.data.signature ? <p className="font-mono text-xs text-muted-foreground">{result.data.signature}</p> : null}
                              {result.data.comment ? <p className="text-xs text-muted-foreground">{result.data.comment}</p> : null}
                              <div className="flex flex-wrap gap-3 text-[11px] tabular-nums text-muted-foreground">
                                <span>{t('index.semanticTest.score')} {result.score.toFixed(6)}</span>
                                <span>{t('index.semanticTest.vectorScore')} {result.vector_score == null ? '—' : result.vector_score.toFixed(6)}</span>
                                <span>{t('index.semanticTest.ftsRank')} {result.fts_rank == null ? '—' : `#${result.fts_rank}`}</span>
                              </div>
                            </div>
                            {onOpenFile && path ? (
                              <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                title={t('index.semanticTest.openFile')}
                                onClick={() => {
                                  onOpenFile(path);
                                  if (diagnostics?.telemetryRequestId) {
                                    void recordProjectSemanticOutcome(
                                      projectId,
                                      diagnostics.telemetryRequestId,
                                      result.vector_score != null
                                        && (result.fts_rank == null || result.fts_rank > 5),
                                    ).catch(() => undefined);
                                  }
                                }}
                              >
                                <ExternalLink className="h-4 w-4" />
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                    {response.results.length === 0 ? (
                      <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">{t('index.semanticTest.noResults')}</p>
                    ) : null}
                  </div>
                </ScrollArea>
              </TabsContent>

              <TabsContent value="pipeline" className="min-h-0 flex-1">
                <ScrollArea className="h-full pr-3">
                  <div className="grid gap-3 pb-2 md:grid-cols-2 xl:grid-cols-3">
                    <DiagnosticCard title={t('index.semanticTest.planning')} icon={<SlidersHorizontal className="h-4 w-4" />} rows={[
                      [t('index.semanticTest.requestedMode'), diagnostics?.requestedMode ?? '—'],
                      [t('index.semanticTest.plannedMode'), diagnostics?.plannedMode ?? '—'],
                      [t('index.semanticTest.effectiveMode'), diagnostics?.effectiveMode ?? '—'],
                      [t('index.semanticTest.plannerReason'), diagnostics?.plannerReason ?? '—'],
                      [t('index.semanticTest.cache'), diagnostics?.cacheHit
                        ? t('index.semanticTest.cacheHit')
                        : t('index.semanticTest.cacheFresh')],
                    ]} />
                    <DiagnosticCard title={t('index.semanticTest.retrieval')} icon={<Search className="h-4 w-4" />} rows={[
                      [t('index.semanticTest.ftsSource'), numeric(diagnostics?.ftsCount)],
                      [t('index.semanticTest.content'), numeric(diagnostics?.contentCount)],
                      [t('index.semanticTest.vectorRaw'), numeric(diagnostics?.vectorRawMatches)],
                      [t('index.semanticTest.vectorHydrated'), numeric(diagnostics?.vectorRehydrated)],
                      [t('index.semanticTest.recent'), numeric(diagnostics?.recentFilesCount)],
                      [t('index.semanticTest.graph'), numeric(diagnostics?.graphExpansionCount)],
                    ]} />
                    <DiagnosticCard title={t('index.semanticTest.inference')} icon={<Braces className="h-4 w-4" />} rows={[
                      [t('index.semanticTest.generation'), diagnostics?.generationUsed ? `g${diagnostics.generationUsed}` : '—'],
                      [t('index.semanticTest.embedder'), diagnostics?.embedder ?? '—'],
                      [t('index.semanticTest.reranker'), diagnostics?.reranker ?? '—'],
                      [t('index.semanticTest.candidates'), numeric(diagnostics?.rerankerCandidates)],
                      [t('index.semanticTest.returned'), numeric(diagnostics?.rerankerReturned)],
                      [t('index.semanticTest.latency'), milliseconds(diagnostics?.totalTimeMs)],
                    ]} />
                    <div className="rounded-lg border p-3 md:col-span-2 xl:col-span-3">
                      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                        {diagnostics?.fallback || diagnostics?.rerankerError
                          ? <AlertCircle className="h-4 w-4 text-amber-500" />
                          : <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
                        {t('index.semanticTest.executionStatus')}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {diagnostics?.fallbackReason ?? diagnostics?.rerankerError ?? diagnostics?.vectorError
                          ?? (diagnostics?.rerankerApplied
                            ? t('index.semanticTest.executionReranked')
                            : t('index.semanticTest.executionRrf'))}
                      </p>
                      {diagnostics?.queryVariants?.length ? (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {diagnostics.queryVariants.map((variant) => <Badge key={variant} variant="outline">{variant}</Badge>)}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </ScrollArea>
              </TabsContent>

              <TabsContent value="consumer" className="min-h-0 flex-1">
                <div className="flex h-full min-h-0 flex-col gap-3">
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="text-sm font-medium">{t('index.semanticTest.previewAs')}</span>
                    <Select value={consumer} onValueChange={(value) => setConsumer(value as SemanticConsumer)}>
                      <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="pipeline">{t('index.semanticTest.consumer.pipeline')}</SelectItem>
                        <SelectItem value="mcp">{t('index.semanticTest.consumer.mcp')}</SelectItem>
                        <SelectItem value="agent">{t('index.semanticTest.consumer.agent')}</SelectItem>
                        <SelectItem value="monaco">{t('index.semanticTest.consumer.monaco')}</SelectItem>
                        <SelectItem value="search_everywhere">{t('index.semanticTest.consumer.searchEverywhere')}</SelectItem>
                      </SelectContent>
                    </Select>
                    <span className="text-xs text-muted-foreground">{t('index.semanticTest.previewHint')}</span>
                  </div>
                  <ScrollArea className="min-h-0 flex-1 rounded-lg border bg-background">
                    <pre className="whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed">{preview}</pre>
                  </ScrollArea>
                </div>
              </TabsContent>
            </Tabs>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SearchTopFive({
  title,
  response,
  compareAgainst,
}: {
  title: string;
  response: ProjectSemanticSearchTestResult;
  compareAgainst?: ProjectSemanticSearchTestResult;
}) {
  const lexicalKeys = new Set((compareAgainst?.results ?? [])
    .slice(0, 5)
    .map((result) => `${result.type}:${semanticResultPath(result)}`));
  return (
    <div className="rounded-lg border bg-muted/10 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <strong className="text-xs">{title}</strong>
        <Badge variant="muted">{milliseconds(response.diagnostics.totalTimeMs)}</Badge>
      </div>
      <ol className="space-y-1.5 text-[11px]">
        {response.results.slice(0, 5).map((result, index) => {
          const path = semanticResultPath(result);
          const semanticOnly = !!compareAgainst
            && !lexicalKeys.has(`${result.type}:${path}`);
          return (
            <li
              key={`${result.type}:${result.id}`}
              className="flex min-w-0 items-center gap-2"
            >
              <span className="w-4 shrink-0 text-right text-muted-foreground">
                {index + 1}.
              </span>
              <span className="min-w-0 flex-1 truncate font-mono">{path}</span>
              {semanticOnly ? <Badge variant="success">só semântico</Badge> : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="space-y-1.5"><div className="text-sm font-medium leading-none">{label}</div>{children}</div>;
}

function DiagnosticCard({
  title,
  icon,
  rows,
}: {
  title: string;
  icon: ReactNode;
  rows: Array<[string, string]>;
}) {
  return (
    <div className="rounded-lg border p-3">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium">{icon}{title}</div>
      <dl className="space-y-2 text-xs">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-3 border-b border-border/50 pb-1.5 last:border-0">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="max-w-[65%] break-all text-right font-mono">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
