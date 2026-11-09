/**
 * Compact table of past QA runs. Click a row → opens `RunDetailModal`.
 * Uses the pure formatters from `core/qa/parsers/run-status-format` for
 * status visuals + duration display.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  formatDurationMs,
} from '@mcp/services/qa/parsers/run-status-format.js';
import { QaStatusBadge } from '../shared/QaStatusBadge.js';
import { formatDateTime } from '../../../../lib/datetime.js';
import { summariseRunI18n } from '../shared/qa-i18n.js';
import type { QaRun } from '../shared/types.js';
import { useRunHistory } from './useRunHistory.js';
import { RunDetailModal } from './RunDetailModal.js';

interface Props {
  sessionId: string;
  serviceId?: string;
}

export function RunHistoryTable({ sessionId, serviceId }: Props) {
  const { t } = useTranslation('agents');
  const { runs, loading, error, refresh } = useRunHistory(sessionId, {
    pollWhenActive: true,
    serviceId,
  });
  const [openRunId, setOpenRunId] = useState<string | null>(null);

  if (loading && runs.length === 0) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
        {t('qa.loadingRuns')}
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 text-sm text-red-600">
        {t('qa.failedRuns', { error })}
        <button onClick={() => void refresh()} className="ml-2 underline">
          {t('qa.retry')}
        </button>
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
        {t('qa.noRunsYet')}
      </div>
    );
  }

  return (
    <>
      <div className="overflow-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground border-b">
            <tr>
              <th className="text-left px-3 py-2">{t('qa.when')}</th>
              <th className="text-left px-3 py-2">{t('qa.suite')}</th>
              <th className="text-left px-3 py-2">{t('qa.statusColumn')}</th>
              <th className="text-left px-3 py-2">{t('qa.result')}</th>
              <th className="text-left px-3 py-2">{t('qa.duration')}</th>
              <th className="text-left px-3 py-2">{t('qa.trigger')}</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <RunRow key={r.id} run={r} onClick={() => setOpenRunId(r.id)} />
            ))}
          </tbody>
        </table>
      </div>
      {openRunId !== null && (
        <RunDetailModal
          sessionId={sessionId}
          runId={openRunId}
          onClose={() => setOpenRunId(null)}
        />
      )}
    </>
  );
}

function RunRow({ run, onClick }: { run: QaRun; onClick: () => void }) {
  const { t } = useTranslation('agents');
  const startedShort = formatDateTime(run.started_at, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  return (
    <tr
      className="border-b hover:bg-muted/40 cursor-pointer"
      onClick={onClick}
    >
      <td className="px-3 py-2 text-xs text-muted-foreground">{startedShort}</td>
      <td className="px-3 py-2 font-medium truncate max-w-[280px]">{run.suite}<span className="block text-[10px] font-normal text-muted-foreground">{run.executor === 'preview' ? 'Preview' : 'Playwright'}</span></td>
      <td className="px-3 py-2">
        <QaStatusBadge kind="run" status={run.status} />
      </td>
      <td className="px-3 py-2 text-xs">
        {summariseRunI18n(t, run.passed, run.failed, run.skipped)}
      </td>
      <td className="px-3 py-2 text-xs text-muted-foreground">
        {formatDurationMs(run.duration_ms)}
      </td>
      <td className="px-3 py-2 text-xs text-muted-foreground capitalize">{run.trigger}</td>
    </tr>
  );
}
