import { summarizeProjectSemanticScopes, summarizeProjectVectorStorage, type ProjectSemanticScope } from './semantic-project-status.js';
import { type ProjectSemanticStatusResult, type SemanticNamespaceStatusView } from './semantic-api.js';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/badge.js';
import { Progress } from '../../components/ui/progress.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card.js';
import { Button } from '../../components/ui/button.js';
import { Loader2, RotateCcw } from 'lucide-react';
import { coveragePercent, formatBytes } from './semantic-indexing-format.js';

function ProjectNamespaceStatus({
  scope,
  status,
  requestError,
  executing,
}: {
  scope: ProjectSemanticScope;
  status: SemanticNamespaceStatusView | null;
  requestError: string | null;
  executing: boolean;
}) {
  const { t } = useTranslation('admin');
  const percent = coveragePercent(status);
  const errors = [requestError, status?.last_error].filter(
    (value): value is string => !!value,
  );
  const failed = status?.failed_items ?? 0;
  const errorCount = errors.length + failed;

  if (!status) {
    return (
      <div className="min-w-56 space-y-2">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t(`semantic.projects.scopes.${scope}`)}
        </p>
        <Badge variant={requestError ? 'destructive' : 'muted'}>
          {requestError
            ? t('semantic.projects.errorCount', { count: 1 })
            : t('semantic.projects.unavailable')}
        </Badge>
        {requestError && (
          <p className="max-w-56 break-words text-[10px] text-destructive">{requestError}</p>
        )}
      </div>
    );
  }

  return (
    <div className="min-w-56 space-y-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {t(`semantic.projects.scopes.${scope}`)}
      </p>
      <div className="space-y-0.5 whitespace-nowrap text-[11px]">
        <p>
          {t('semantic.projects.activeGeneration', {
            id: status.active?.generationId ?? '—',
          })}
        </p>
        <p className={status.building && executing ? 'text-info' : 'text-muted-foreground'}>
          {t('semantic.projects.buildingGeneration', {
            id: status.building?.generationId ?? '—',
          })}
        </p>
      </div>
      <div>
        <div className="flex items-center justify-between gap-2 text-[11px]">
          <span className="text-muted-foreground">{t('semantic.projects.metrics.coverage')}</span>
          <span className="tabular-nums">
            {status.expected_items
              ? t('semantic.coverage.value', {
                  indexed: status.indexed_items,
                  total: status.expected_items,
                  percent: Math.round(percent),
                })
              : t('semantic.coverage.waiting')}
          </span>
        </div>
        <Progress
          className="mt-1.5 h-1.5"
          value={percent}
          indeterminate={!!status.building && executing && !status.expected_items}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={status.delta_items > 0 ? 'text-[11px] text-warning' : 'text-[11px] text-muted-foreground'}>
          {t('semantic.projects.metrics.delta', { count: status.delta_items })}
        </span>
        {errorCount > 0 ? (
          <Badge variant="destructive">
            {t('semantic.projects.errorCount', { count: errorCount })}
          </Badge>
        ) : status.active ? (
          <Badge variant="success">{t('semantic.projects.healthy')}</Badge>
        ) : status.building ? (
          <Badge variant={executing ? 'info' : 'warning'}>
            {t(executing ? 'semantic.status.building' : 'semantic.status.pending')}
          </Badge>
        ) : (
          <Badge variant="warning">{t('semantic.projects.notActive')}</Badge>
        )}
      </div>
      {errors[0] && (
        <p className="max-w-56 break-words text-[10px] text-destructive">{errors[0]}</p>
      )}
    </div>
  );
}

export function ProjectSemanticStatusTable({
  results,
  globalStorage,
  loading,
  reindexingProjectId,
  codeProfileRunning,
  memoryProfileRunning,
  executingNamespaces,
  codeIndexingDisabled,
  onReindexProject,
}: {
  results: ProjectSemanticStatusResult[];
  globalStorage: SemanticNamespaceStatusView[];
  loading: boolean;
  reindexingProjectId: number | null;
  codeProfileRunning: boolean;
  memoryProfileRunning: boolean;
  executingNamespaces: ReadonlySet<string>;
  codeIndexingDisabled: boolean;
  onReindexProject: (project: ProjectSemanticStatusResult['project']) => void;
}) {
  const { t } = useTranslation('admin');
  const docsNamespaces = new Map<string, SemanticNamespaceStatusView>();
  for (const namespace of globalStorage) {
    if (namespace.namespace.startsWith('docs:')) docsNamespaces.set(namespace.namespace, namespace);
  }
  for (const result of results) {
    for (const namespace of result.status?.namespaces ?? []) {
      if (namespace.namespace.startsWith('docs:')) docsNamespaces.set(namespace.namespace, namespace);
    }
  }
  const docs = [...docsNamespaces.values()];
  const docsPath = docs[0]?.dbPath ?? null;
  const docsSize = docs[0]?.size_bytes ?? 0;
  const docsExpected = docs.reduce((total, namespace) => total + namespace.expected_items, 0);
  const docsIndexed = docs.reduce((total, namespace) => total + namespace.indexed_items, 0);
  const docsFailed = docs.reduce((total, namespace) => total + namespace.failed_items, 0);
  const memory = globalStorage.find((namespace) => namespace.namespace === 'memory:user') ?? null;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold">{t('semantic.projects.title')}</h3>
        <p className="text-xs text-muted-foreground">{t('semantic.projects.description')}</p>
      </div>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1320px] text-left text-xs">
            <thead className="border-b bg-muted/30 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">{t('semantic.projects.columns.project')}</th>
                <th className="px-4 py-3">{t('semantic.projects.columns.database')}</th>
                <th className="px-4 py-3">{t('semantic.projects.columns.size')}</th>
                <th className="px-4 py-3">{t('semantic.projects.scopes.code')}</th>
                <th className="px-4 py-3">{t('semantic.projects.scopes.snapshot')}</th>
                <th className="px-4 py-3">{t('semantic.projects.scopes.project_memory')}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {results.map((result) => {
                const scopes = summarizeProjectSemanticScopes(result);
                const storage = summarizeProjectVectorStorage(scopes);
                const codeNamespace = result.status?.namespaces.find(
                  (entry) => entry.namespace === `code:p${result.project.id}`,
                );
                const projectJobStatus = result.status?.reindex_job?.status;
                const projectBuilding = codeProfileRunning
                  || projectJobStatus === 'running';
                return (
                  <tr key={result.project.id} className="align-top">
                    <td className="px-4 py-3">
                      <p className="font-medium">{result.project.name}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {t('semantic.projects.projectId', { id: result.project.id })}
                      </p>
                      <Button
                        className="mt-3"
                        variant="outline"
                        size="sm"
                        disabled={codeIndexingDisabled || projectBuilding || reindexingProjectId === result.project.id}
                        onClick={() => onReindexProject(result.project)}
                      >
                        {projectBuilding || reindexingProjectId === result.project.id ? (
                          <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RotateCcw className="mr-2 h-3.5 w-3.5" />
                        )}
                        {t(codeNamespace?.active
                          ? 'semantic.actions.reindexProject'
                          : 'semantic.actions.indexProject')}
                      </Button>
                    </td>
                    <td className="max-w-sm px-4 py-3">
                      {storage.dbPaths.length > 0 ? (
                        storage.dbPaths.map((dbPath) => (
                          <p key={dbPath} className="break-all font-mono text-[11px] text-muted-foreground">
                            {dbPath}
                          </p>
                        ))
                      ) : (
                        <p className="text-muted-foreground">{t('semantic.projects.unavailable')}</p>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 font-medium tabular-nums">
                      {storage.dbPaths.length > 0 ? formatBytes(storage.sizeBytes) : '—'}
                    </td>
                    {scopes.map((scope) => (
                      <td key={scope.scope} className="px-4 py-3">
                        <ProjectNamespaceStatus
                          scope={scope.scope}
                          status={scope.status}
                          requestError={result.error
                            ?? (scope.scope === 'code' ? result.status?.reindex_job?.error ?? null : null)}
                          executing={scope.scope === 'code'
                            ? projectBuilding
                            : memoryProfileRunning
                              || (!!scope.status && executingNamespaces.has(scope.status.namespace))}
                        />
                      </td>
                    ))}
                  </tr>
                );
              })}
              {!loading && results.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                    {t('semantic.projects.empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {loading && results.length === 0 && (
          <div className="flex items-center justify-center border-t px-4 py-8 text-xs text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t('semantic.projects.loading')}
          </div>
        )}
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">{t('semantic.global.title')}</CardTitle>
          <CardDescription>{t('semantic.global.description')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          <div className="rounded-lg border bg-muted/10 p-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-semibold">{t('semantic.global.docs')}</p>
              {docsPath && <Badge variant="info">{formatBytes(docsSize)}</Badge>}
            </div>
            <p className="mt-2 break-all font-mono text-[11px] text-muted-foreground">
              {docsPath ?? t('semantic.global.docsUnavailable')}
            </p>
            {docsPath && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                {t('semantic.global.coverage', {
                  indexed: docsIndexed,
                  total: docsExpected,
                  failed: docsFailed,
                })}
              </p>
            )}
          </div>
          <div className="rounded-lg border border-dashed bg-muted/10 p-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-semibold">{t('semantic.global.memory')}</p>
              {memory && <Badge variant="info">{formatBytes(memory.size_bytes)}</Badge>}
            </div>
            <p className="mt-2 break-all font-mono text-[11px] text-muted-foreground">
              {memory?.dbPath ?? t('semantic.global.memoryUnavailable')}
            </p>
            {memory && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span>
                  {t('semantic.global.coverage', {
                    indexed: memory.indexed_items,
                    total: memory.expected_items,
                    failed: memory.failed_items,
                  })}
                </span>
                <Badge variant={memory.active
                  ? 'success'
                  : memory.building && (memoryProfileRunning || executingNamespaces.has(memory.namespace))
                    ? 'info'
                    : memory.building
                      ? 'warning'
                      : 'muted'}>
                  {memory.active
                    ? t('semantic.projects.activeGeneration', {
                        id: memory.active.generationId,
                      })
                    : memory.building && (memoryProfileRunning || executingNamespaces.has(memory.namespace))
                      ? t('semantic.projects.buildingGeneration', {
                          id: memory.building.generationId,
                        })
                      : memory.building
                        ? t('semantic.status.pending')
                      : t('semantic.projects.notActive')}
                </Badge>
              </div>
            )}
            {memory?.last_error && (
              <p className="mt-2 break-words text-[11px] text-destructive">{memory.last_error}</p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
