import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { cleanupUnusedSemanticVectors, fetchSemanticGenerations, fetchSemanticProfiles, fetchProjectSemanticStatuses, reindexProjectSemanticCode, reindexSemanticProfile, type SemanticGenerationView, type SemanticJobView, type SemanticRerankerStatusView, type ProjectSemanticStatusResult, type SemanticNamespaceStatusView, type SemanticProfilePurpose, type SemanticProfileView, type SemanticUnusedVectorCleanupResult } from './semantic-api.js';
import type { AdminProvider } from './types.js';
import { fetchProviders } from './api.js';
import { confirm as confirmDialog, toast } from '../../components/ui/prompt-dialog.js';
import { AlertCircle, Database, HardDrive, Loader2, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert.js';
import { PURPOSES, latestPurposeJob, isExecutingSemanticJob, fallbackProfile, formatBytes, latestGeneration } from './semantic-indexing-format.js';
import { ProfileCard } from './semantic-profile-card.js';
import { ProjectSemanticStatusTable } from './semantic-project-status-table.js';
import { ProfileDialog } from './semantic-profile-dialog.js';

export function SemanticIndexingPanel() {
  const { t } = useTranslation('admin');
  const [profiles, setProfiles] = useState<SemanticProfileView[]>([]);
  const [generations, setGenerations] = useState<SemanticGenerationView[]>([]);
  const [jobs, setJobs] = useState<SemanticJobView[]>([]);
  const [globalStorage, setGlobalStorage] = useState<SemanticNamespaceStatusView[]>([]);
  const [rerankers, setRerankers] = useState<Record<
    SemanticProfilePurpose,
    SemanticRerankerStatusView
  >>({
    code: { target_kind: 'missing', diagnostics: null, error: null },
    docs: { target_kind: 'missing', diagnostics: null, error: null },
    memory: { target_kind: 'missing', diagnostics: null, error: null },
  });
  const [providers, setProviders] = useState<AdminProvider[]>([]);
  const [projectStatuses, setProjectStatuses] = useState<ProjectSemanticStatusResult[]>([]);
  const [editing, setEditing] = useState<SemanticProfileView | null>(null);
  const [reindexing, setReindexing] = useState<SemanticProfilePurpose | null>(null);
  const [reindexingProjectId, setReindexingProjectId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cleaningUnused, setCleaningUnused] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<SemanticUnusedVectorCleanupResult | null>(null);

  const load = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setError(null);
    try {
      const [nextProfiles, nextSemanticState, nextProviders, nextProjectStatuses] = await Promise.all([
        fetchSemanticProfiles(),
        fetchSemanticGenerations(),
        fetchProviders(),
        fetchProjectSemanticStatuses(),
      ]);
      setProfiles(nextProfiles);
      setGenerations(nextSemanticState.generations);
      setJobs(nextSemanticState.jobs);
      setGlobalStorage(nextSemanticState.storage);
      setRerankers(nextSemanticState.rerankers);
      setProviders(nextProviders);
      setProjectStatuses(nextProjectStatuses);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const purposeJobs = useMemo(() => Object.fromEntries(PURPOSES.map((purpose) => [
    purpose,
    latestPurposeJob(purpose, jobs, generations),
  ])) as Record<SemanticProfilePurpose, SemanticJobView | null>, [jobs, generations]);
  const executingNamespaces = useMemo(() => new Set(
    jobs.filter(isExecutingSemanticJob).map((job) => job.namespace),
  ), [jobs]);
  // Physical `building` pointers survive a crash so a later explicit request
  // can resume atomically. They are not proof that work is consuming CPU.
  // Poll only while the durable queue says a worker is actually executing (or
  // an explicit control marker is waiting for its same-turn microtask).
  const shouldPoll = reindexing !== null || jobs.some(isExecutingSemanticJob);
  useEffect(() => {
    if (!shouldPoll) return;
    const timer = window.setInterval(() => void load(false), 3_000);
    return () => window.clearInterval(timer);
  }, [shouldPoll, load]);

  const visibleProfiles = PURPOSES.map(
    (purpose) => profiles.find((profile) => profile.purpose === purpose) ?? fallbackProfile(purpose),
  );

  async function startReindex(purpose: SemanticProfilePurpose) {
    if (!(await confirmDialog({
      title: t('semantic.actions.reindex'),
      description: t('semantic.actions.reindexConfirm', {
        purpose: t(`semantic.purpose.${purpose}.title`),
      }),
      confirmLabel: t('semantic.actions.reindex'),
      tone: 'destructive',
    }))) {
      return;
    }
    setReindexing(purpose);
    setError(null);
    try {
      await reindexSemanticProfile(purpose);
      await load(false);
    } catch (reindexError) {
      setError(reindexError instanceof Error ? reindexError.message : String(reindexError));
    } finally {
      setReindexing(null);
    }
  }

  async function startProjectReindex(project: ProjectSemanticStatusResult['project']) {
    if (!(await confirmDialog({
      title: t('semantic.actions.reindexProject'),
      description: t('semantic.actions.reindexProjectConfirm', { project: project.name }),
      confirmLabel: t('semantic.actions.reindexProject'),
      tone: 'destructive',
    }))) {
      return;
    }
    setReindexingProjectId(project.id);
    setError(null);
    try {
      await reindexProjectSemanticCode(project.id);
      await load(false);
    } catch (reindexError) {
      setError(reindexError instanceof Error ? reindexError.message : String(reindexError));
    } finally {
      setReindexingProjectId(null);
    }
  }

  async function cleanupUnusedVectors() {
    if (!(await confirmDialog({
      title: t('semantic.actions.cleanupUnused'),
      description: t('semantic.actions.cleanupUnusedConfirm'),
      confirmLabel: t('semantic.actions.cleanupUnused'),
      tone: 'destructive',
    }))) return;
    setCleaningUnused(true);
    setCleanupResult(null);
    setError(null);
    try {
      const result = await cleanupUnusedSemanticVectors();
      setCleanupResult(result);
      const description = t('semantic.cleanup.resultDescription', {
        tables: result.tables_removed,
        items: result.items_removed,
        databases: result.databases_compacted,
        bytes: formatBytes(result.bytes_reclaimed),
        skipped: result.skipped_referenced,
      });
      if (result.failures.length > 0) {
        toast.warning(t('semantic.cleanup.resultTitle'), {
          description: `${description} ${t('semantic.cleanup.failureCount', {
            count: result.failures.length,
          })}`,
        });
      } else {
        toast.success(t('semantic.cleanup.resultTitle'), { description });
      }
      await load(false);
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      setError(message);
      toast.error(t('semantic.loadError'), { description: message });
    } finally {
      setCleaningUnused(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Database className="h-5 w-5" />
            {t('semantic.title')}
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {t('semantic.description')}
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void cleanupUnusedVectors()}
            disabled={cleaningUnused || loading || reindexing !== null || jobs.some(isExecutingSemanticJob)}
          >
            {cleaningUnused ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="mr-2 h-4 w-4" />
            )}
            {t('semantic.actions.cleanupUnused')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading || cleaningUnused}>
            {loading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            {t('semantic.actions.refresh')}
          </Button>
        </div>
      </div>

      <Alert variant="info">
        <HardDrive />
        <AlertTitle>{t('semantic.localOnly.title')}</AlertTitle>
        <AlertDescription>{t('semantic.localOnly.description')}</AlertDescription>
      </Alert>

      <Alert>
        <Sparkles />
        <AlertTitle>{t('semantic.onDemand.title')}</AlertTitle>
        <AlertDescription>{t('semantic.onDemand.description')}</AlertDescription>
      </Alert>

      {error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>{t('semantic.loadError')}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {cleanupResult && (
        <Alert variant={cleanupResult.failures.length > 0 ? 'warning' : 'success'}>
          <HardDrive />
          <AlertTitle>{t('semantic.cleanup.resultTitle')}</AlertTitle>
          <AlertDescription>
            {t('semantic.cleanup.resultDescription', {
              tables: cleanupResult.tables_removed,
              items: cleanupResult.items_removed,
              databases: cleanupResult.databases_compacted,
              bytes: formatBytes(cleanupResult.bytes_reclaimed),
              skipped: cleanupResult.skipped_referenced,
            })}
            {cleanupResult.failures.length > 0
              ? ` ${t('semantic.cleanup.failureCount', { count: cleanupResult.failures.length })}`
              : ''}
          </AlertDescription>
        </Alert>
      )}

      {loading && profiles.length === 0 ? (
        <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          {t('semantic.loading')}
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-3">
          {visibleProfiles.map((profile) => (
            <ProfileCard
              key={profile.purpose}
              profile={profile}
              generation={latestGeneration(profile.purpose, generations)}
              job={purposeJobs[profile.purpose]}
              rerankerStatus={rerankers[profile.purpose]}
              providers={providers}
              reindexing={reindexing === profile.purpose}
              onEdit={() => setEditing(profile)}
              onReindex={() => void startReindex(profile.purpose)}
            />
          ))}
        </div>
      )}

      <ProjectSemanticStatusTable
        results={projectStatuses}
        globalStorage={globalStorage}
        loading={loading}
        reindexingProjectId={reindexingProjectId}
        codeProfileRunning={!!purposeJobs.code && isExecutingSemanticJob(purposeJobs.code)}
        memoryProfileRunning={jobs.some((job) =>
          job.namespace === 'semantic:reindex:memory' && isExecutingSemanticJob(job))}
        executingNamespaces={executingNamespaces}
        codeIndexingDisabled={visibleProfiles.find((profile) => profile.purpose === 'code')
          ?.embedding_target.kind === 'disabled'}
        onReindexProject={(project) => void startProjectReindex(project)}
      />

      {editing && (
        <ProfileDialog
          profile={editing}
          providers={providers}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setProfiles((current) => [
              ...current.filter((profile) => profile.purpose !== saved.purpose),
              saved,
            ]);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}
