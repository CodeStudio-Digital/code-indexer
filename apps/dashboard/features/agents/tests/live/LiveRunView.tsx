/**
 * Composer for the "Live" sub-view. Shows the active run header
 * (suite, progress, duration so far) plus the spec→tests tree. When no
 * run is in flight, renders a v4.5 diagnostic panel that explains WHY
 * (last error, watchdog kills, reporter drift, endpoint state) instead
 * of a mute placeholder.
 */
import React from 'react';
import {
  formatDurationMs,
  summariseRun,
} from '@mcp/services/qa/parsers/run-status-format.js';
import { QaStatusBadge } from '../shared/QaStatusBadge.js';
import { LiveRunTree } from './LiveRunTree.js';
import { useLiveRun } from './useLiveRun.js';
import { useQaDiagnostics } from './useQaDiagnostics.js';
import type { QaDiagnostics } from '../shared/types.js';

interface Props {
  sessionId: number;
  serviceId?: string;
}

const WATCHDOG_PREFIX = 'No events received from reporter';

export function LiveRunView({ sessionId, serviceId }: Props) {
  const { run, results, loading } = useLiveRun(sessionId, { serviceId });
  const showDiagnostics = !loading && !run;
  const diag = useQaDiagnostics(sessionId, showDiagnostics);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
        Checking for active QA run…
      </div>
    );
  }

  if (!run) {
    return <EmptyStatePanel diagnostics={diag.data} loading={diag.loading} error={diag.error} />;
  }

  const elapsedMs = computeElapsed(run.started_at);

  return (
    <div className="flex flex-col h-full">
      <header className="px-4 py-3 border-b flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <QaStatusBadge kind="run" status={run.status} />
          <span className="text-sm font-semibold truncate max-w-[280px]">{run.suite}</span>
        </div>
        <div className="text-xs text-muted-foreground">
          {summariseRun(run.passed, run.failed, run.skipped)}
        </div>
        <div className="ml-auto text-xs text-muted-foreground tabular-nums">
          Elapsed: {formatDurationMs(elapsedMs)}
        </div>
      </header>
      <div className="flex-1 overflow-auto py-3">
        <LiveRunTree results={results} />
      </div>
    </div>
  );
}

function EmptyStatePanel({
  diagnostics,
  loading,
  error,
}: {
  diagnostics: QaDiagnostics | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        Loading diagnostics…
      </div>
    );
  }

  if (error || !diagnostics) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <p className="text-sm text-muted-foreground">No QA run in flight.</p>
        <p className="text-xs text-muted-foreground mt-1">
          When the QA agent starts a Playwright suite, results stream here in real time.
        </p>
        {error ? <p className="text-xs text-red-600 mt-2">Diagnostics unavailable: {error}</p> : null}
      </div>
    );
  }

  const { last_run, watchdog_kills_24h, reporter_drift, endpoint_state } = diagnostics;
  const watchdogHit = !!last_run?.last_error?.startsWith(WATCHDOG_PREFIX);

  return (
    <div className="px-4 py-6 space-y-3 max-w-3xl mx-auto">
      <div className="text-sm font-medium">No QA run in flight</div>
      <p className="text-xs text-muted-foreground">
        When the QA agent starts a Playwright suite, results stream here in real time. Below:
        recent run state, reporter health, and endpoint configuration.
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
            Last run: <code>#{last_run.id}</code> · suite <code>{last_run.suite}</code> ·{' '}
            <span className="capitalize">{last_run.status}</span>
          </div>
          <div className="text-muted-foreground mt-1">
            Started {last_run.started_at} · {summariseRun(last_run.passed, last_run.failed, last_run.skipped)}
          </div>
          {last_run.last_error ? (
            <div className="mt-2">
              <div className="font-medium text-red-700 dark:text-red-400">Error</div>
              <div className="font-mono text-[11px] mt-0.5 whitespace-pre-wrap">
                {last_run.last_error}
              </div>
              {watchdogHit ? (
                <p className="mt-2 text-muted-foreground">
                  Hint: the reporter never POST'd events. Check that the agent called{' '}
                  <code>qa_start_run</code> before <code>npx playwright test</code>, did NOT pass{' '}
                  <code>--reporter=…</code> on the CLI, and that the container can reach{' '}
                  <code>{endpoint_state.full_endpoint}</code>.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="rounded border border-muted bg-muted/30 p-3 text-xs text-muted-foreground">
          No QA runs have ever been recorded for this session.
        </div>
      )}

      {/* Watchdog kills */}
      {watchdog_kills_24h > 0 ? (
        <div className="rounded border border-red-300 bg-red-50 dark:bg-red-950/20 p-3 text-xs">
          <div className="font-medium text-red-700 dark:text-red-400">
            Watchdog killed {watchdog_kills_24h} run{watchdog_kills_24h === 1 ? '' : 's'} in the last 24h
          </div>
          <p className="text-muted-foreground mt-1">
            Each one started but never received reporter events. Consult the QA Playwright skill
            doc — common cause is{' '}
            <code>--reporter=…</code> on the CLI overriding <code>playwright.config.ts</code>.
          </p>
        </div>
      ) : null}

      {/* Reporter drift */}
      {!reporter_drift.no_sandbox ? (
        <DriftPanel drift={reporter_drift} />
      ) : (
        <div className="rounded border border-yellow-300 bg-yellow-50 dark:bg-yellow-950/20 p-3 text-xs">
          <div className="font-medium">Sandbox not provisioned</div>
          <p className="text-muted-foreground mt-1">
            QA artifacts cannot be inspected — provision the project sandbox first.
          </p>
        </div>
      )}

      {/* Endpoint state */}
      <EndpointPanel state={endpoint_state} />
    </div>
  );
}

function DriftPanel({ drift }: { drift: QaDiagnostics['reporter_drift'] }) {
  const issues: Array<{ kind: 'critical' | 'warn'; text: string }> = [];
  if (!drift.config_present) {
    issues.push({
      kind: 'warn',
      text: 'playwright.config.ts is missing — install it from the Restore QA config button or run `qa_start_run`.',
    });
  }
  if (!drift.reporter_template_match) {
    issues.push({
      kind: 'critical',
      text: 'tests/e2e/reporter.ts has been edited — streaming may be broken. Click "Restore QA config" to revert.',
    });
  }
  if (!drift.global_setup_match) {
    issues.push({
      kind: 'critical',
      text: 'tests/e2e/global-setup.ts has been edited — preview cookie injection may be broken.',
    });
  }
  for (const m of drift.config_missing) {
    issues.push({ kind: 'critical', text: `playwright.config.ts is missing: ${m}` });
  }
  for (const r of drift.config_recommendations) {
    issues.push({ kind: 'warn', text: r });
  }

  if (issues.length === 0) {
    return (
      <div className="rounded border border-green-300 bg-green-50 dark:bg-green-950/20 p-3 text-xs">
        <div className="font-medium text-green-700 dark:text-green-400">Reporter & config look healthy</div>
        <p className="text-muted-foreground mt-1">
          tests/e2e/reporter.ts, global-setup.ts and playwright.config.ts match the v4.5 templates.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded border border-yellow-300 bg-yellow-50 dark:bg-yellow-950/20 p-3 text-xs space-y-1">
      <div className="font-medium">Reporter / config drift detected</div>
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
  return (
    <div
      className={`rounded border p-3 text-xs ${
        state.fallback
          ? 'border-yellow-300 bg-yellow-50 dark:bg-yellow-950/20'
          : 'border-muted bg-muted/30'
      }`}
    >
      <div className="font-medium">
        Reporter endpoint{' '}
        {state.fallback ? (
          <span className="text-yellow-700 dark:text-yellow-400">(runtime fallback)</span>
        ) : (
          <span className="text-green-700 dark:text-green-400">(MCP_PUBLIC_URL set)</span>
        )}
      </div>
      <div className="font-mono mt-1 break-all">{state.full_endpoint}</div>
      {state.fallback ? (
        <p className="text-muted-foreground mt-2">
          MCP_PUBLIC_URL is not set on the host — the reporter targets the container-runtime
          loopback alias. If your sandbox cannot resolve <code>host.docker.internal</code> /{' '}
          <code>host.containers.internal</code>, set MCP_PUBLIC_URL on the server and re-run.
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
