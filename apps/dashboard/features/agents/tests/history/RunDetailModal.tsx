/**
 * Drill-down for a single QA run — lists every test outcome with its
 * status, duration, error, and inline icons for screenshot / video /
 * trace artifacts. Header includes a button to open the full
 * Playwright HTML report. Modal closes via Escape or backdrop.
 *
 * v4.2: results are `QaTestResultWithUrls` (server-enriched) so the
 * frontend doesn't reimplement URL encoding. Lightbox preview for
 * images and videos via `ArtifactPreview`.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Camera, Film, FileText, Bug } from 'lucide-react';
import { fetchRunDetail } from '../api/qa-api.js';
import {
  formatDurationMs,
} from '@mcp/services/qa/parsers/run-status-format.js';
import { QaStatusBadge } from '../shared/QaStatusBadge.js';
import { QaErrorClassHint } from '../shared/QaErrorClassHint.js';
import { TraceLinkButton } from '../shared/TraceLinkButton.js';
import { ArtifactPreview } from '../shared/ArtifactPreview.js';
import { summariseRunI18n } from '../shared/qa-i18n.js';
import type { QaRun, QaTestResultWithUrls } from '../shared/types.js';

interface Props {
  sessionId: string;
  runId: string;
  onClose: () => void;
}

interface RunDetail {
  run: QaRun;
  results: QaTestResultWithUrls[];
  report_url: string;
}

export function RunDetailModal({ sessionId, runId, onClose }: Props) {
  return <ScopedRunDetailModal key={`${sessionId}:${runId}`} sessionId={sessionId} runId={runId} onClose={onClose} />;
}

function ScopedRunDetailModal({ sessionId, runId, onClose }: Props) {
  const { t } = useTranslation('agents');
  const [data, setData] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchRunDetail({ sessionId, runId })
      .then((d) => !cancelled && setData(d))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [sessionId, runId]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 bg-background/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border rounded-lg shadow-lg max-w-3xl w-full max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-4 py-3 border-b gap-3">
          <h2 className="text-sm font-semibold">{t('qa.runDetailTitle')}</h2>
          <div className="flex items-center gap-3 text-xs">
            {data?.report_url && data.run.executor !== 'preview' && (
              <a
                href={data.report_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
                title={t('qa.openHtmlReportTitle')}
              >
                <ExternalLink className="h-3 w-3" />
                {t('qa.openHtmlReport')}
              </a>
            )}
            <button
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground"
              aria-label={t('common.close')}
            >
              {t('qa.closeEsc')}
            </button>
          </div>
        </header>
        <div className="flex-1 overflow-auto p-4 space-y-4">
          {error && <p className="text-sm text-red-600">{t('qa.failed', { error })}</p>}
          {!data && !error && (
            <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
          )}
          {data && (
            <RunDetailBody sessionId={sessionId} run={data.run} results={data.results} />
          )}
        </div>
      </div>
    </div>
  );
}

function RunDetailBody({
  sessionId,
  run,
  results,
}: {
  sessionId: string;
  run: QaRun;
  results: QaTestResultWithUrls[];
}) {
  const { t } = useTranslation('agents');
  return (
    <>
      <div className="space-y-1">
        {run.target_url && <p className="text-xs text-muted-foreground break-all">Alvo: {run.target_url} · {run.criteria?.length ?? 0} critérios</p>}
        <div className="flex items-center gap-2">
          <span className="text-base font-semibold truncate">{run.suite}</span>
          <QaStatusBadge kind="run" status={run.status} />
          <span className="text-xs text-muted-foreground">{run.executor === 'preview' ? 'Preview' : 'Playwright'}</span>
          {run.service_id && run.service_id !== 'main' && (
            <span className="text-[10px] uppercase tracking-wider bg-muted px-1.5 py-0.5 rounded">
              {run.service_id}
            </span>
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          {summariseRunI18n(t, run.passed, run.failed, run.skipped)} ·{' '}
          {formatDurationMs(run.duration_ms)} · {run.trigger}
        </div>
      </div>

      {/* B7 — run-level error with a friendly per-class hint; raw text kept as detail. */}
      {run.last_error ? (
        <div className="rounded border border-red-300 bg-red-50 dark:bg-red-950/20 p-2 text-xs">
          <div className="font-medium text-red-700 dark:text-red-400">{t('qa.error')}</div>
          <QaErrorClassHint errorClass={run.error_class} />
          <pre className="font-mono text-[11px] mt-1 whitespace-pre-wrap">{run.last_error}</pre>
        </div>
      ) : null}

      {results.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('qa.noRows')}
        </p>
      ) : (
        <ul className="space-y-2">
          {results.map((r) => (
            <ResultRow key={r.id} sessionId={sessionId} result={r} />
          ))}
        </ul>
      )}
    </>
  );
}

function ResultRow({
  sessionId,
  result,
}: {
  sessionId: string;
  result: QaTestResultWithUrls;
}) {
  const { t } = useTranslation('agents');
  const [preview, setPreview] = useState<
    | { kind: 'screenshot'; url: string; path: string }
    | { kind: 'video'; url: string; path: string }
    | null
  >(null);

  return (
    <li className="border rounded p-2 text-sm">
      <div className="flex items-center gap-2">
        <QaStatusBadge kind="test" status={result.status} />
        <span className="truncate">{result.test_name}</span>
        <span className="ml-auto text-xs text-muted-foreground">
          {formatDurationMs(result.duration_ms)}
        </span>
      </div>
      <div className="text-xs text-muted-foreground mt-0.5 truncate">
        {result.spec_file}
      </div>
      {result.error && (
        <pre className="mt-2 text-xs whitespace-pre-wrap text-red-700 bg-red-50 p-2 rounded">
          {result.error}
        </pre>
      )}
      {(result.screenshot_url ||
        result.video_url ||
        result.trace_url ||
        result.summary_md_url ||
        result.kanban_card_id) && (
        <div className="mt-2 flex items-center gap-3 text-xs flex-wrap">
          {result.screenshot_url && result.screenshot_path && (
            <button
              onClick={() =>
                setPreview({
                  kind: 'screenshot',
                  url: result.screenshot_url!,
                  path: result.screenshot_path!,
                })
              }
              className="inline-flex items-center gap-1 text-primary hover:underline"
              title={t('qa.previewTitle', { path: result.screenshot_path })}
            >
              <Camera className="h-3 w-3" /> {t('qa.screenshot')}
            </button>
          )}
          {result.video_url && result.video_path && (
            <button
              onClick={() =>
                setPreview({
                  kind: 'video',
                  url: result.video_url!,
                  path: result.video_path!,
                })
              }
              className="inline-flex items-center gap-1 text-primary hover:underline"
              title={t('qa.previewTitle', { path: result.video_path })}
            >
              <Film className="h-3 w-3" /> {t('qa.video')}
            </button>
          )}
          {result.trace_path && (
            <TraceLinkButton sessionId={sessionId} tracePath={result.trace_path} />
          )}
          {result.summary_md_url && (
            <a
              href={result.summary_md_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
              title={t('qa.openTitle', { path: result.summary_md_path ?? 'summary.md' })}
            >
              <FileText className="h-3 w-3" /> summary.md
            </a>
          )}
          {result.kanban_card_id && (
            <a
              href={`#/kanban?card=${result.kanban_card_id}`}
              className="inline-flex items-center gap-1 text-red-600 hover:underline"
              title={t('qa.openBugCardTitle')}
            >
              <Bug className="h-3 w-3" /> {t('qa.bugCard', { id: result.kanban_card_id })}
            </a>
          )}
        </div>
      )}
      {preview && (
        <ArtifactPreview
          kind={preview.kind}
          url={preview.url}
          path={preview.path}
          onClose={() => setPreview(null)}
        />
      )}
    </li>
  );
}
