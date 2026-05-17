/**
 * Compact table of past QA runs. Click a row → opens `RunDetailModal`.
 * Uses the pure formatters from `core/qa/parsers/run-status-format` for
 * status visuals + duration display.
 */
import React, { useState } from 'react';
import {
  formatDurationMs,
  summariseRun,
} from '@mcp/services/qa/parsers/run-status-format.js';
import { QaStatusBadge } from '../shared/QaStatusBadge.js';
import type { QaRun } from '../shared/types.js';
import { useRunHistory } from './useRunHistory.js';
import { RunDetailModal } from './RunDetailModal.js';

interface Props {
  sessionId: number;
  serviceId?: string;
}

export function RunHistoryTable({ sessionId, serviceId }: Props) {
  const { runs, loading, error, refresh } = useRunHistory(sessionId, {
    pollWhenActive: true,
    serviceId,
  });
  const [openRunId, setOpenRunId] = useState<number | null>(null);

  if (loading && runs.length === 0) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
        Loading runs…
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 text-sm text-red-600">
        Failed to load runs: {error}
        <button onClick={() => void refresh()} className="ml-2 underline">
          Retry
        </button>
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
        No QA runs yet. The QA agent publishes results here as soon as it runs `npx playwright test`.
      </div>
    );
  }

  return (
    <>
      <div className="overflow-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground border-b">
            <tr>
              <th className="text-left px-3 py-2">When</th>
              <th className="text-left px-3 py-2">Suite</th>
              <th className="text-left px-3 py-2">Status</th>
              <th className="text-left px-3 py-2">Result</th>
              <th className="text-left px-3 py-2">Duration</th>
              <th className="text-left px-3 py-2">Trigger</th>
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
  const startedShort = new Date(run.started_at + 'Z').toLocaleString(undefined, {
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
      <td className="px-3 py-2 font-medium truncate max-w-[280px]">{run.suite}</td>
      <td className="px-3 py-2">
        <QaStatusBadge kind="run" status={run.status} />
      </td>
      <td className="px-3 py-2 text-xs">
        {summariseRun(run.passed, run.failed, run.skipped)}
      </td>
      <td className="px-3 py-2 text-xs text-muted-foreground">
        {formatDurationMs(run.duration_ms)}
      </td>
      <td className="px-3 py-2 text-xs text-muted-foreground capitalize">{run.trigger}</td>
    </tr>
  );
}
