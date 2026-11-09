/**
 * Composer for the "Live" sub-view. Shows the active run header
 * (suite, progress, duration so far) plus the spec→tests tree. When no
 * run is in flight, renders a v4.5 diagnostic panel that explains WHY
 * (last error, watchdog kills, reporter drift, endpoint state) instead
 * of a mute placeholder.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  formatDurationMs,
} from '@mcp/services/qa/parsers/run-status-format.js';
import { QaStatusBadge } from '../shared/QaStatusBadge.js';
import { QaErrorClassHint } from '../shared/QaErrorClassHint.js';
import { summariseRunI18n } from '../shared/qa-i18n.js';
import { LiveRunTree } from './LiveRunTree.js';
import { useLiveRun } from './useLiveRun.js';
import type { QaDiagnostics } from '../shared/types.js';

interface Props {
  sessionId: string;
  serviceId?: string;
}

const WATCHDOG_PREFIX = 'No events received from reporter';

export function LiveRunView({ sessionId, serviceId }: Props) {
  const { t } = useTranslation('agents');
  const { run, results, loading, error } = useLiveRun(sessionId, { serviceId });

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
        {t('qa.checkingActiveRun')}
      </div>
    );
  }

  if (!run) {
    return <div className="p-4 space-y-4 overflow-auto h-full">
      <div className="rounded-lg border bg-card p-4 space-y-2">
        <h3 className="font-medium text-sm">Validação no preview</h3>
        <p className="text-sm text-muted-foreground">Defina os critérios na tarefa e delegue a validação ao agente QA. O CodeStudio verifica a página real e salva capturas e resultados nesta sessão.</p>
        <p className="text-xs text-muted-foreground">Nenhuma execução ativa. Novas execuções aparecem automaticamente; resultados concluídos ficam no Histórico.</p>
        {error && <p role="alert" className="text-sm text-destructive">Não foi possível consultar as execuções: {error}</p>}
      </div>
    </div>;
  }

  const elapsedMs = computeElapsed(run.started_at);

  return (
    <div className="flex flex-col h-full">
      <header className="px-4 py-3 border-b flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <QaStatusBadge kind="run" status={run.status} />
          <span className="text-sm font-semibold truncate max-w-[280px]">{run.suite}</span>
          <span className="text-xs text-muted-foreground">{run.executor === 'preview' ? 'Preview' : 'Playwright'}</span>
        </div>
        <div className="text-xs text-muted-foreground">
          {summariseRunI18n(t, run.passed, run.failed, run.skipped)}
        </div>
        <div className="ml-auto text-xs text-muted-foreground tabular-nums">
          {t('qa.elapsed', { duration: formatDurationMs(elapsedMs) })}
        </div>
      </header>
      <div className="flex-1 overflow-auto py-3">
        <LiveRunTree results={results} />
      </div>
    </div>
  );
}

export function QaDiagnosticsPanel({
  diagnostics,
  loading,
  error,
}: {
  diagnostics: QaDiagnostics | null;
  loading: boolean;
  error: string | null;
}) {
  const { t } = useTranslation('agents');
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        {t('qa.loadingDiagnostics')}
      </div>
    );
  }

  if (error || !diagnostics) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        {error ? <p className="text-xs text-red-600">{t('qa.diagnosticsUnavailable', { error })}</p> : <p className="text-xs text-muted-foreground">{t('qa.loadingDiagnostics')}</p>}
      </div>
    );
  }

  const { last_run, watchdog_kills_24h, reporter_drift, endpoint_state } = diagnostics;
  const watchdogHit = !!last_run?.last_error?.startsWith(WATCHDOG_PREFIX);

  return (
    <div className="px-4 py-6 space-y-3 max-w-3xl mx-auto">
      <div className="text-sm font-medium">Diagnóstico da regressão</div>
      <p className="text-xs text-muted-foreground">
        {t('qa.diagnosticsIntro')}
      </p>

      {/* Last run summary */}
      {last_run ? (
        <div
          className={`rounded border p-3 text-xs ${
            watchdogHit
              ? 'border-red-300 bg-red-50 dark:bg-red-950/20'
              : 'border-muted bg-muted/30'
          }`}
        >
          <div className="font-medium">
            {t('qa.lastRun')} <code>#{last_run.id}</code> · {t('qa.suite')} <code>{last_run.suite}</code> ·{' '}
            <span className="capitalize">{last_run.status}</span>
          </div>
          <div className="text-muted-foreground mt-1">
            {t('qa.started', {
              date: last_run.started_at,
              summary: summariseRunI18n(t, last_run.passed, last_run.failed, last_run.skipped),
            })}
          </div>
          {last_run.last_error ? (
            <div className="mt-2">
              <div className="font-medium text-red-700 dark:text-red-400">{t('qa.error')}</div>
              {/* B7 — friendly hint per machine-readable class; raw text stays as detail. */}
              <QaErrorClassHint errorClass={last_run.error_class} />
              <div className="font-mono text-[11px] mt-0.5 whitespace-pre-wrap">
                {last_run.last_error}
              </div>
              {watchdogHit ? (
                <p className="mt-2 text-muted-foreground">
                  {t('qa.watchdogHint', { endpoint: endpoint_state.full_endpoint })}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="rounded border border-muted bg-muted/30 p-3 text-xs text-muted-foreground">
          {t('qa.noRunsRecorded')}
        </div>
      )}

      {/* Watchdog kills */}
      {watchdog_kills_24h > 0 ? (
        <div className="rounded border border-red-300 bg-red-50 dark:bg-red-950/20 p-3 text-xs">
          <div className="font-medium text-red-700 dark:text-red-400">
            {t('qa.watchdogKilled', { count: watchdog_kills_24h })}
          </div>
          <p className="text-muted-foreground mt-1">
            {t('qa.watchdogCause')}
          </p>
        </div>
      ) : null}

      {/* Reporter drift */}
      {!reporter_drift.no_sandbox ? (
        <DriftPanel drift={reporter_drift} />
      ) : (
        <div className="rounded border border-yellow-300 bg-yellow-50 dark:bg-yellow-950/20 p-3 text-xs">
          <div className="font-medium">{t('qa.sandboxNotProvisioned')}</div>
          <p className="text-muted-foreground mt-1">
            {t('qa.sandboxHint')}
          </p>
        </div>
      )}

      {/* Endpoint state */}
      <EndpointPanel state={endpoint_state} />
    </div>
  );
}

function DriftPanel({ drift }: { drift: QaDiagnostics['reporter_drift'] }) {
  const { t } = useTranslation('agents');
  const issues: Array<{ kind: 'critical' | 'warn'; text: string }> = [];
  if (!drift.config_present) {
    issues.push({
      kind: 'warn',
      text: t('qa.driftConfigMissing'),
    });
  }
  if (!drift.reporter_template_match) {
    issues.push({
      kind: 'critical',
      text: t('qa.driftReporterEdited'),
    });
  }
  if (!drift.global_setup_match) {
    issues.push({
      kind: 'critical',
      text: t('qa.driftGlobalSetupEdited'),
    });
  }
  for (const m of drift.config_missing) {
    issues.push({ kind: 'critical', text: t('qa.driftMissingSetting', { setting: m }) });
  }
  for (const r of drift.config_recommendations) {
    issues.push({ kind: 'warn', text: r });
  }

  if (issues.length === 0) {
    return (
      <div className="rounded border border-green-300 bg-green-50 dark:bg-green-950/20 p-3 text-xs">
        <div className="font-medium text-green-700 dark:text-green-400">{t('qa.reporterHealthy')}</div>
        <p className="text-muted-foreground mt-1">
          {t('qa.reporterHealthyHint')}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded border border-yellow-300 bg-yellow-50 dark:bg-yellow-950/20 p-3 text-xs space-y-1">
      <div className="font-medium">{t('qa.reporterDrift')}</div>
      <ul className="space-y-1 mt-1">
        {issues.map((i, idx) => (
          <li
            key={idx}
            className={i.kind === 'critical' ? 'text-red-700 dark:text-red-400' : 'text-muted-foreground'}
          >
            {i.kind === 'critical' ? '✗ ' : '⚠ '}
            {i.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

function EndpointPanel({ state }: { state: QaDiagnostics['endpoint_state'] }) {
  const { t } = useTranslation('agents');
  return (
    <div
      className={`rounded border p-3 text-xs ${
        state.fallback
          ? 'border-yellow-300 bg-yellow-50 dark:bg-yellow-950/20'
          : 'border-muted bg-muted/30'
      }`}
    >
      <div className="font-medium">
        {t('qa.endpointTitle')}{' '}
        {state.fallback ? (
          <span className="text-yellow-700 dark:text-yellow-400">{t('qa.endpointRuntimeFallback')}</span>
        ) : (
          <span className="text-green-700 dark:text-green-400">{t('qa.endpointPublicUrlSet')}</span>
        )}
      </div>
      <div className="font-mono mt-1 break-all">{state.full_endpoint}</div>
      {state.fallback ? (
        <p className="text-muted-foreground mt-2">
          {t('qa.endpointFallbackHint')}
        </p>
      ) : null}
    </div>
  );
}

function computeElapsed(startedAtUtc: string): number {
  // SQLite emits `YYYY-MM-DD HH:MM:SS` without TZ; we treat as UTC.
  const ms = Date.parse(startedAtUtc.replace(' ', 'T') + 'Z');
  if (Number.isNaN(ms)) return 0;
  return Date.now() - ms;
}
