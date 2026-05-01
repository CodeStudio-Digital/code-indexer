/**
 * Collapsible tree of `spec → tests` for the currently-running QA suite.
 * Pure presentational — receives the result list and renders it. Groups
 * are derived per-render from the flat `QaTestResultWithUrls[]`.
 */
import React from 'react';
import { formatDurationMs } from '../../../../../../core/qa/parsers/run-status-format.js';
import { QaStatusBadge } from '../shared/QaStatusBadge.js';
import type { QaTestResultWithUrlsWithUrls } from '../shared/types.js';

interface Props {
  results: QaTestResultWithUrlsWithUrls[];
}

export function LiveRunTree({ results }: Props) {
  if (results.length === 0) {
    return (
      <div className="text-sm text-muted-foreground italic px-3 py-2">
        Waiting for the first test to report…
      </div>
    );
  }

  const grouped = groupBySpec(results);
  return (
    <ul className="space-y-2 px-3">
      {Array.from(grouped.entries()).map(([spec, rows]) => (
        <SpecGroup key={spec} spec={spec} rows={rows} />
      ))}
    </ul>
  );
}

function groupBySpec(results: QaTestResultWithUrls[]): Map<string, QaTestResultWithUrls[]> {
  const map = new Map<string, QaTestResultWithUrls[]>();
  for (const r of results) {
    const list = map.get(r.spec_file) ?? [];
    list.push(r);
    map.set(r.spec_file, list);
  }
  return map;
}

function SpecGroup({ spec, rows }: { spec: string; rows: QaTestResultWithUrls[] }) {
  return (
    <li>
      <div className="text-xs font-mono text-muted-foreground mb-1 truncate">{spec}</div>
      <ul className="space-y-1 ml-2">
        {rows.map((r) => (
          <li key={r.id} className="text-sm flex items-center gap-2">
            <QaStatusBadge kind="test" status={r.status} />
            <span className="truncate">{r.test_name}</span>
            <span className="ml-auto text-[11px] text-muted-foreground flex-shrink-0">
              {formatDurationMs(r.duration_ms)}
            </span>
          </li>
        ))}
      </ul>
    </li>
  );
}
