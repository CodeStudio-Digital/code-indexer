import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ChevronDown, ChevronRight, FlaskConical, Loader2 } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Progress } from '../../components/ui/progress.js';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../components/ui/collapsible.js';

interface EmbeddingStats {
  coverage: {
    files_total: number;
    files_embedded: number;
    symbols_total: number;
    symbols_embedded: number;
    symbol_bodies_total: number;
    symbol_bodies_embedded: number;
  };
  vectorIds: {
    total: number;
    byType: Record<string, number>;
  };
  health: {
    embeddingService: string;
    vectorStore: string;
    vectorStoreAvailable: boolean;
  };
  fingerprint?: {
    stored: string | null;
    live: string | null;
    mismatch: boolean;
  };
  // Loaded lazily from /embeddings/samples after the headline stats render.
  sampleEmbedded?: Array<{ type: string; path: string; embeddingHash: string }>;
  sampleNotEmbedded?: Array<{ type: string; path: string }>;
}

interface TestStep {
  step: string;
  ok: boolean;
  detail?: string;
  error?: string;
}

interface TestMatch {
  vectorId: string;
  score: number;
  type: string;
  refId: number;
  rehydrated: boolean;
  path?: string;
  name?: string;
}

interface TestResult {
  steps: TestStep[];
  matches: TestMatch[];
}

function CoverageStat({ label, value, total }: { label: string; value: number; total: number }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums font-medium">{value}/{total} ({pct}%)</span>
      </div>
      <Progress value={pct} className="h-1.5" />
    </div>
  );
}

export function EmbeddingsDebugPanel({ projectId }: { projectId: number }) {
  const { t } = useTranslation(['search', 'common']);
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState<EmbeddingStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [testQuery, setTestQuery] = useState('');
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testLoading, setTestLoading] = useState(false);

  // Always reflects the current prop, so async resolutions can detect a
  // project switch that happened while they were in flight.
  const projectIdRef = useRef(projectId);
  useEffect(() => { projectIdRef.current = projectId; }, [projectId]);

  // This panel instance is reused across project switches (the index surface
  // isn't keyed by projectId), so reset on change — otherwise it keeps showing
  // the previous project's coverage/health and re-arms the load.
  useEffect(() => {
    setStats(null);
    setTestResult(null);
  }, [projectId]);

  const loadStats = useCallback(async () => {
    const reqProjectId = projectId;
    setLoading(true);
    try {
      const r = await fetch(`/api/projects/${projectId}/embeddings/stats`);
      const data = await r.json();
      if (reqProjectId !== projectIdRef.current) return; // switched mid-flight
      setStats(data);
    } finally {
      if (reqProjectId === projectIdRef.current) setLoading(false);
    }
    // Defer the random-scan samples — they don't gate the coverage display.
    try {
      const sr = await fetch(`/api/projects/${projectId}/embeddings/samples`);
      if (sr.ok) {
        const samples = (await sr.json()) as Pick<EmbeddingStats, 'sampleEmbedded' | 'sampleNotEmbedded'>;
        if (reqProjectId !== projectIdRef.current) return; // don't splice onto another project
        setStats((prev) => (prev ? { ...prev, ...samples } : prev));
      }
    } catch { /* samples are best-effort */ }
  }, [projectId]);

  useEffect(() => {
    if (open && !stats) void loadStats();
  }, [open, stats, loadStats]);

  const runTest = async () => {
    if (!testQuery.trim()) return;
    setTestLoading(true);
    try {
      const r = await fetch(`/api/projects/${projectId}/embeddings/test-query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: testQuery }),
      });
      setTestResult(await r.json());
    } finally {
      setTestLoading(false);
    }
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-2 w-full py-2 px-3 rounded-md hover:bg-muted/50 text-sm cursor-pointer">
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <FlaskConical className="h-4 w-4 text-muted-foreground" />
        <span className="font-medium">{t('search:debug.title')}</span>
        {stats && (
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            {t('search:debug.filesEmbedded', { embedded: stats.coverage.files_embedded, total: stats.coverage.files_total })}
          </span>
        )}
      </CollapsibleTrigger>

      <CollapsibleContent className="px-3 pb-3 space-y-4">
        {loading && <div className="text-xs text-muted-foreground py-2">{t('common:actions.loading')}</div>}

        {stats && (
          <>
            {/* Health */}
            <div className="flex flex-wrap gap-2">
              <Badge variant={stats.health.embeddingService === 'null' ? 'destructive' : 'outline'}>
                {t('search:debug.embedding')} {stats.health.embeddingService}
              </Badge>
              <Badge variant={stats.health.vectorStore === 'null' ? 'destructive' : 'outline'}>
                {t('search:debug.vectorStore')} {stats.health.vectorStore}
              </Badge>
              <Badge variant={stats.health.vectorStoreAvailable ? 'default' : 'destructive'}>
                {stats.health.vectorStoreAvailable ? t('common:status.available') : t('common:status.unavailable')}
              </Badge>
            </div>

            {/* Warnings */}
            {stats.health.embeddingService === 'null' && (
              <div className="flex items-start gap-2 p-2 rounded-md bg-destructive/10 text-destructive text-xs">
                <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span>{t('search:debug.noEmbedding')}</span>
              </div>
            )}
            {stats.health.vectorStore === 'null' && (
              <div className="flex items-start gap-2 p-2 rounded-md bg-destructive/10 text-destructive text-xs">
                <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span>{t('search:debug.noVectorStore')}</span>
              </div>
            )}
            {stats.coverage.files_embedded === 0 && stats.health.embeddingService !== 'null' && (
              <div className="flex items-start gap-2 p-2 rounded-md bg-orange-500/10 text-orange-600 dark:text-orange-400 text-xs">
                <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span>{t('search:debug.noFiles')}</span>
              </div>
            )}
            {stats.fingerprint?.mismatch && (
              <div className="flex items-start gap-2 p-2 rounded-md bg-orange-500/10 text-orange-600 dark:text-orange-400 text-xs">
                <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span>{t('search:debug.fingerprintMismatch', { stored: stats.fingerprint.stored, live: stats.fingerprint.live })}</span>
              </div>
            )}

            {/* Coverage */}
            <div className="space-y-2">
              <CoverageStat label={t('search:debug.files')} value={stats.coverage.files_embedded} total={stats.coverage.files_total} />
              <CoverageStat label={t('search:debug.symbols')} value={stats.coverage.symbols_embedded} total={stats.coverage.symbols_total} />
              <CoverageStat label={t('search:debug.symbolBodies')} value={stats.coverage.symbol_bodies_embedded} total={stats.coverage.symbol_bodies_total} />
            </div>

            {/* Vector IDs by type */}
            <div className="text-xs space-y-0.5">
              <div className="font-medium text-muted-foreground">{t('search:debug.vectorIds')} {stats.vectorIds.total}</div>
              <div className="flex gap-3 text-muted-foreground tabular-nums">
                {Object.entries(stats.vectorIds.byType).map(([type, count]) => (
                  <span key={type}>{type}: {count}</span>
                ))}
              </div>
            </div>

            {/* Samples */}
            {stats.sampleEmbedded && stats.sampleEmbedded.length > 0 && (
              <div className="text-xs space-y-1">
                <div className="font-medium text-muted-foreground">{t('search:debug.sampleEmbedded')}</div>
                {stats.sampleEmbedded.map((f, i) => (
                  <div key={i} className="font-mono text-[11px] truncate">
                    <span className="text-emerald-500">{f.embeddingHash}</span>{' '}
                    {f.path}
                  </div>
                ))}
              </div>
            )}
            {stats.sampleNotEmbedded && stats.sampleNotEmbedded.length > 0 && (
              <div className="text-xs space-y-1">
                <div className="font-medium text-muted-foreground">{t('search:debug.sampleNotEmbedded')}</div>
                {stats.sampleNotEmbedded.map((f, i) => (
                  <div key={i} className="font-mono text-[11px] text-muted-foreground truncate">{f.path}</div>
                ))}
              </div>
            )}
          </>
        )}

        {/* Test query */}
        <div className="space-y-2 pt-2 border-t">
          <div className="text-xs font-medium text-muted-foreground">{t('search:debug.testQuery')}</div>
          <div className="flex gap-2">
            <Input
              placeholder={t('search:debug.testPlaceholder')}
              value={testQuery}
              onChange={(e) => setTestQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && runTest()}
              className="text-xs h-8"
            />
            <Button size="sm" onClick={runTest} disabled={testLoading} className="h-8">
              {testLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : t('common:actions.test')}
            </Button>
          </div>

          {testResult && (
            <div className="space-y-2">
              {/* Steps */}
              <div className="space-y-1">
                {testResult.steps.map((s, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <span className={`h-2 w-2 rounded-full shrink-0 ${s.ok ? 'bg-emerald-500' : 'bg-destructive'}`} />
                    <span className="font-medium">{s.step}</span>
                    {s.detail && <span className="text-muted-foreground">{s.detail}</span>}
                    {s.error && <span className="text-destructive">{s.error}</span>}
                  </div>
                ))}
              </div>

              {/* Matches */}
              {testResult.matches.length > 0 && (
                <div className="space-y-1">
                  <div className="text-xs font-medium text-muted-foreground">{t('search:debug.matches')}</div>
                  {testResult.matches.map((m, i) => (
                    <div key={i} className="flex items-center gap-2 text-[11px] font-mono">
                      <Badge variant={m.rehydrated ? 'default' : 'destructive'} className="h-4 text-[10px]">
                        {m.type}
                      </Badge>
                      <span className="text-emerald-500 tabular-nums">{m.score.toFixed(3)}</span>
                      <span className="truncate">{m.path ?? `ref:${m.refId}`}{m.name ? `:${m.name}` : ''}</span>
                      {!m.rehydrated && <span className="text-destructive">{t('search:debug.missingInDb')}</span>}
                    </div>
                  ))}
                </div>
              )}
              {testResult.matches.length === 0 && testResult.steps.length > 0 && (
                <div className="text-xs text-muted-foreground">{t('search:debug.noMatches')}</div>
              )}
              {/* Warn when unfiltered finds matches but filtered doesn't — metadata index missing */}
              {testResult.steps.find(s => s.step === 'search_unfiltered')?.ok &&
               !testResult.steps.find(s => s.step === 'search')?.ok && (
                <div className="flex items-start gap-2 p-2 rounded-md bg-orange-500/10 text-orange-600 dark:text-orange-400 text-xs">
                  <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span>
                    {t('search:debug.vectorsExist')} <code className="bg-muted px-1 rounded">wrangler vectorize create-metadata-index &lt;index&gt; --propertyName=project_name --type=string</code> {t('search:debug.thenReindex')}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
