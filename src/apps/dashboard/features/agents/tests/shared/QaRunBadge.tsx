/**
 * Header badge that summarises the latest QA run for a session.
 * Rendered next to the session name in `CompanySessionView` when the
 * session has at least one QA run on record. Hidden otherwise — no
 * visual noise for sessions that don't use QA.
 *
 * The badge re-fetches on `refreshKey` change, so the host can bump it
 * after spawning a QA agent / clicking "Run now" without owning the
 * fetching logic.
 */
import React from 'react';
import { FlaskConical } from 'lucide-react';
import { summariseRun } from '../../../../../../core/qa/parsers/run-status-format.js';
import { useLastQaRun } from './useLastQaRun.js';
import type { QaRun } from './types.js';

interface Props {
  sessionId: number;
  refreshKey?: number;
}

export function QaRunBadge({ sessionId, refreshKey }: Props) {
  const run = useLastQaRun(sessionId, refreshKey);
  if (!run) return null;
  const tone = toneClass(run);
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border ${tone}`}
      title={`QA: ${run.suite} — ${run.status}`}
    >
      <FlaskConical className="h-3 w-3" />
      <span className="truncate max-w-[140px]">{run.suite}</span>
      <span className="opacity-80">·</span>
      <span>{summariseRun(run.passed, run.failed, run.skipped)}</span>
    </span>
  );
}

function toneClass(run: QaRun): string {
  if (run.status === 'running') return 'border-sky-300 bg-sky-50 text-sky-700';
  if (run.status === 'aborted') return 'border-zinc-300 bg-zinc-50 text-zinc-600';
  if (run.status === 'error' || run.failed > 0) return 'border-red-300 bg-red-50 text-red-700';
  return 'border-emerald-300 bg-emerald-50 text-emerald-700';
}
